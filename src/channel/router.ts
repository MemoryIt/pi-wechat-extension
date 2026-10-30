/**
 * router.ts - 消息路由（turn 编排唯一入口 + 队列排空）
 *
 * 拥有并集中管理 `TurnQueue` 的状态迁移（忙闲 / currentRequestId / 排空），
 * 是 turn 编排的唯一入口：
 * - dispatch               : 忙或终端处理中 -> 入队，否则执行（原 Channel.triggerAi）
 * - onTurnDone             : 释放忙闲 + 排空（原 Channel.onAiDone）
 * - execute                : 媒体消息后台处理 / 文本 turn 交给宿主 agent
 * - drain                  : 20ms 延迟后取队首并执行
 * - processMediaInBackground: 后台下载并落盘媒体
 *
 * 仅依赖注入的窄接口（queue? / mediaStore / mediaQueue / sender / host / opts /
 * isTerminalProcessing / logger），不直接持有通道编排器，便于单测。
 */

import type { WeixinMessage } from "../ports/types.js";
import { TurnQueue } from "./queue.js";
import type { SerialTaskQueue } from "./queue.js";
import type { MediaStore } from "./media-store.js";
import type { MessageSender } from "./sender.js";
import type { PluginLogger } from "../shared/logger.js";
import { sleep } from "../shared/time.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import { parseInbound } from "./inbound-parser.js";

export type RouterTurnOptions = WechatApiOpts;

export interface RouterDeps {
  /** 缺省在 router 内创建；保留注入便于测试观察。 */
  queue?: TurnQueue<{ msg: WeixinMessage; requestId: string }>;
  mediaStore: MediaStore;
  mediaQueue: SerialTaskQueue;
  sender: MessageSender;
  getHost(): PiHost | null;
  getOpts(): RouterTurnOptions | null;
  /** 终端消息处理中（原 Channel 直接读取 state.isTerminalMessageProcessing）。 */
  isTerminalProcessing(): boolean;
  logger: PluginLogger;
}

export class MessageRouter {
  readonly queue: TurnQueue<{ msg: WeixinMessage; requestId: string }>;

  constructor(private deps: RouterDeps) {
    this.queue = deps.queue ?? new TurnQueue<{ msg: WeixinMessage; requestId: string }>();
  }

  /**
   * turn 编排唯一入口（原 Channel.triggerAi）。
   * 忙或终端消息处理中 -> 入队等待；否则直接执行。
   */
  async dispatch(msg: WeixinMessage, requestId: string, opts: RouterTurnOptions): Promise<void> {
    const { queue } = this;
    if (queue.isBusy() || this.deps.isTerminalProcessing()) {
      queue.enqueue({ msg, requestId });
      this.deps.logger.debug(
        `AI is ${queue.isBusy() ? "processing" : "terminal processing"}, queued message (queue size: ${queue.size})`,
      );
      return;
    }

    await this.execute(msg, requestId, opts);
  }

  /**
   * AI 处理完成（原 Channel.onAiDone）：释放忙闲并继续排空。
   */
  onTurnDone(): void {
    const { queue } = this;
    queue.setBusy(false);
    queue.setCurrentRequestId(null);

    if (queue.size > 0) {
      void this.drain();
    }
  }

  /**
   * 执行一次 turn（原 triggerAiInternal）。
   * 媒体消息：立即 ack，下载/落盘丢到后台串行队列，随后标记处理完成并排空。
   * 文本消息：占用忙闲标记，交给宿主 agent；失败时释放并排空。
   */
  async execute(msg: WeixinMessage, requestId: string, opts: RouterTurnOptions): Promise<void> {
    const { mediaQueue, logger } = this.deps;
    const { queue } = this;

    // === 媒体消息处理 ===
    const parsed = parseInbound(msg);

    if (parsed.hasMedia && !parsed.hasText) {
      logger.debug(`Media message detected, acknowledging and processing in background...`);

      // B5：立即 ack（不含路径），下载/落盘放到后台串行队列，不阻塞轮询主循环。
      // F6：ack 失败只记录日志，不得抛给调用方，也不影响后续入队/标记/排空。
      try {
        await this.deps.sender.sendText("媒体文件已收到，正在保存…");
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Media ack failed (requestId=${requestId}):`, errMsg);
      }

      mediaQueue.enqueue(() => this.processMediaInBackground(msg, requestId, opts));

      // 标记处理完成并退出
      queue.markRequestProcessed(requestId);

      // 处理队列中的下一条
      if (queue.size > 0) {
        this.drain();
      }
      return;
    }

    // === 文本消息处理 ===
    queue.setCurrentRequestId(requestId);
    queue.setBusy(true);
    let handedOffToAgent = false;

    try {
      const host = this.deps.getHost();
      if (!host) throw new Error("WechatHost not configured");

      logger.debug(`triggerAi: requestId=${requestId}`);

      // 写入 wechat_meta（仅 requestId）—— pi 调用可能同步抛错
      host.appendEntry("wechat_meta", { requestId });

      // 直接使用解析后的文本内容
      const content = parsed.text;

      // sendUserMessage 为同步 void：同步抛错必须在这里被捕获，不得冒泡成「轮询失败」
      host.sendUserMessage(content, { deliverAs: "followUp" });
      handedOffToAgent = true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`execute failed (requestId=${requestId}):`, errMsg);
      queue.markRequestProcessed(requestId);
    } finally {
      // 错误路径：无论从哪个 await 抛出都必须释放处理锁并继续排空队列。
      // 成功路径保持 isAiProcessing=true，等待 onAiDone() 通知本轮结束。
      if (!handedOffToAgent) {
        queue.setBusy(false);
        queue.setCurrentRequestId(null);
        if (queue.size > 0) {
          void this.drain();
        }
      }
    }
  }

  /**
   * 安全地触发下一条消息（原 safelyTriggerNext）。
   *
   * 必须 await 并 catch execute，否则排空时的 rejection 会变成未处理
   * 拒绝并卡死 isAiProcessing。移除了基于错误字符串匹配的重试，避免无限递归。
   */
  async drain(): Promise<void> {
    const { queue } = this;
    const { logger } = this.deps;
    const BASE_DELAY = 20;
    await sleep(BASE_DELAY);

    if (queue.size === 0) {
      queue.setBusy(false);
      return;
    }

    const { msg, requestId } = queue.dequeue()!;
    logger.debug(`Triggering next message (queue size: ${queue.size})`);

    const opts = this.deps.getOpts();
    if (!opts) {
      logger.error("Failed to process queued message: engine config missing");
      queue.setBusy(false);
      if (queue.size > 0) void this.drain();
      return;
    }

    try {
      await this.execute(msg, requestId, opts);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to process queued message: ${errMsg}`);
      queue.setBusy(false);
      queue.setCurrentRequestId(null);
      if (queue.size > 0) void this.drain();
    }
  }

  /**
   * B5：后台串行处理媒体下载/落盘，完成后写入会话历史（含保存路径）。
   * 外层 try/catch 保证不向调用方抛出。
   */
  private async processMediaInBackground(
    msg: WeixinMessage,
    requestId: string,
    opts: RouterTurnOptions,
  ): Promise<void> {
    const { mediaStore, logger } = this.deps;
    try {
      const paths = await mediaStore.downloadAll(msg.item_list ?? [], opts.baseUrl);

      if (paths.length > 0) {
        const host = this.deps.getHost();
        if (!host) throw new Error("WechatHost not configured");

        host.sendMessage(
          { customType: "wechat_media", content: `媒体文件已保存到 ${paths[0]}`, display: false },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      }
    } catch (err) {
      logger.error(`processMediaInBackground failed (requestId=${requestId}):`, err);
    }
  }
}
