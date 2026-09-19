/**
 * router.ts - 消息路由（turn 执行 + 队列排空）
 *
 * 从 wechat.ts 抽出的「turn 执行 + 队列排空」职责，行为与抽取前逐字对应：
 * - execute                : 原 triggerAiInternal（媒体后台 / 文本 turn）
 * - drain                  : 原 safelyTriggerNext（20ms 延迟后取队首并执行）
 * - processMediaInBackground: 原同名私有方法
 *
 * 仅依赖注入的窄接口（queue / mediaStore / mediaQueue / sender / host / opts / logger），
 * 不直接持有 WechatEngine，便于单测。
 */

import { MessageItemType } from "../../api/types.js";
import type { WeixinMessage } from "../../api/types.js";
import type { TurnQueue, SerialTaskQueue } from "./queue.js";
import type { MediaStore } from "./media-store.js";
import type { MessageSender } from "./sender.js";
import type { PluginLogger } from "../shared/logger.js";
import type { WechatHost } from "./wechat.js";

export type RouterTurnOptions = { baseUrl: string; token: string };

export interface RouterDeps {
  queue: TurnQueue<{ msg: WeixinMessage; requestId: string }>;
  mediaStore: MediaStore;
  mediaQueue: SerialTaskQueue;
  sender: MessageSender;
  getHost(): WechatHost | null;
  getOpts(): RouterTurnOptions | null;
  logger: PluginLogger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MessageRouter {
  constructor(private deps: RouterDeps) {}

  /**
   * 执行一次 turn（原 triggerAiInternal）。
   * 媒体消息：立即 ack，下载/落盘丢到后台串行队列，随后标记处理完成并排空。
   * 文本消息：占用忙闲标记，交给宿主 agent；失败时释放并排空。
   */
  async execute(msg: WeixinMessage, requestId: string, opts: RouterTurnOptions): Promise<void> {
    const { queue, mediaQueue, logger } = this.deps;

    // === 媒体消息处理 ===
    const hasText = msg.item_list?.some(item => item.type === MessageItemType.TEXT && item.text_item?.text?.trim());
    const hasMedia = msg.item_list?.some(item => item.type !== MessageItemType.TEXT);

    if (hasMedia && !hasText) {
      logger.debug(`Media message detected, acknowledging and processing in background...`);

      // B5：立即 ack（不含路径），下载/落盘放到后台串行队列，不阻塞轮询主循环。
      await this.deps.sender.sendText("媒体文件已收到，正在保存…");

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

      // 直接获取文本内容
      const textParts: string[] = [];
      for (const item of msg.item_list ?? []) {
        if (item.type === MessageItemType.TEXT) {
          textParts.push(item.text_item?.text ?? "");
        }
      }
      const content = textParts.join("\n");

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
    const { queue, logger } = this.deps;
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
