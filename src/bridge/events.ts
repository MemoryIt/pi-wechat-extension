/**
 * events.ts - 事件桥接
 *
 * 从 index.ts 拆出：注册所有 `pi.on(...)` 处理器；`agent_settled` 的发送决策
 * 委托给应用层的 `ReplyService`（见 `src/application/reply.ts`），会话生命周期
 * （session_start 自动连接 / session_shutdown 关闭）委托 `SessionService`
 * （见 `src/application/session.ts`）。
 *
 * 事件桥接的核心约定：
 * - 每轮 turn 的身份（`{ fromWechat, requestId }`）都在事件发生时通过
 *   `turn.resolveTurnBeforeRun()` / `resolveTurnFromBranch()` 从 session 中同步解析，
 *   并显式传给处理函数。
 * - 最终回复在 `agent_settled` 发送（一轮 prompt 只发一次，覆盖重试/压缩/续跑后的最终版）；
 *   `agent_end` 只负责 typing 收敛与终端标志兜底。
 * - `turn` / `meta` / `logger` 等状态均由组合根创建并经 `BridgeDeps` 注入，
 *   桥接模块不再持有模块级可变状态。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginLogger } from "../shared/logger.js";
import type { Notifier } from "../channel/state.js";
import {
  resolveTurnFromBranch,
  isAssistantMessage,
  extractLastReply,
  type TurnResolver,
} from "./turn.js";
import type { MetaBuilder } from "./meta.js";
import type { ReplyService } from "../application/reply.js";
import type { SessionService } from "../application/session.js";
import { createSessionUi } from "./session-ui.js";

/** `registerBridge` 消费的最小通道面（窄接口）：不依赖具体 `Channel` 实现。 */
export interface BridgeChannel {
  setNotifier(notifier: Notifier): void;
  setTerminalProcessing(value: boolean): void;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
}

export interface BridgeDeps {
  channel: BridgeChannel;
  reply: ReplyService;
  session: SessionService;
  turn: TurnResolver;
  meta: MetaBuilder;
  logger: PluginLogger;
}

export function registerBridge(pi: ExtensionAPI, deps: BridgeDeps): void {
  const { channel, reply, session, meta, logger } = deps;

  // ============== session_start ==============

  pi.on("session_start", async (_event, ctx) => {
    // 不再用空 render 覆盖内置 footer；分支名通过 pi.exec 获取。
    await meta.refreshGitBranch(pi);

    // B4：会话过期（needs_relogin）时通过 UI 通知用户
    channel.setNotifier((msg, type) => ctx.ui.notify(msg, type ?? "info"));

    // 会话生命周期（自动连接）收拢到 SessionService
    await session.startFromStoredToken(createSessionUi(ctx));
  });

  // ============== session_shutdown ==============

  pi.on("session_shutdown", async () => {
    session.shutdown();
  });

  // ============== input ==============
  // pi.sendUserMessage 注入时 source === "extension"。把待处理微信消息文本入队，
  // 供 before_agent_start 在无法从 session 判断来源时用 event.prompt 兜底匹配。
  pi.on("input", (event, ctx) => {
    const inputEvent = event as { source?: string; text?: string };
    if (inputEvent.source !== "extension") return { action: "continue" };

    const turn = deps.turn.resolveTurnBeforeRun(ctx);
    if (turn.fromWechat) {
      deps.turn.pushPendingWechatInput({ requestId: turn.requestId, text: inputEvent.text ?? "" });
    }
    return { action: "continue" };
  });

  // ============== before_agent_start ==============

  pi.on("before_agent_start", async (event, ctx) => {
    // 同步捕获本轮 turn 的身份，不做任何延迟。
    // 此刻当前 user 消息尚未写入分支（pi 在 before_agent_start 之后才 append），
    // 因此用「最近一条 wechat_meta 是否位于最后一条 assistant 之后」判断。
    const turn = deps.turn.resolveTurnBeforeRun(ctx, (event as { prompt?: string }).prompt);
    if (turn.fromWechat) {
      logger.debug(`before_agent_start: WeChat turn detected, requestId=${turn.requestId ?? "(unknown)"}`);
    } else {
      // 终端消息正在处理，微信消息需要排队
      channel.setTerminalProcessing(true);
      logger.debug(`before_agent_start: Terminal turn, WeChat messages will be queued`);
    }
  });

  // ============== message_start / message_end（typing）==============
  // 只在 assistant 消息上开启 / 停止 typing；user / toolResult 的结束不得提前关闭。

  pi.on("message_start", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    logger.debug(`message_start: starting typing keepalive`);
    await channel.startTyping();
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    logger.debug(`message_end: stopping typing keepalive`);
    await channel.stopTyping();
  });

  // ============== agent_end ==============
  // 只用于 typing 收敛（以及终端标志兜底），最终回复统一在 agent_settled 发送。

  pi.on("agent_end", async (_event, ctx) => {
    const turn = resolveTurnFromBranch(ctx);
    if (turn.fromWechat) {
      await channel.stopTyping();
    } else {
      channel.setTerminalProcessing(false);
    }
  });

  // ============== agent_settled ==============

  pi.on("agent_settled", async (_event, ctx) => {
    // 每轮结束时的可靠信号：pi 不会再有自动重试 / 压缩 / 续跑。
    // bridge 只负责「事件 → DTO」，发送决策由应用层 ReplyService 处理。
    const turn = resolveTurnFromBranch(ctx);
    const notify = (message: string, type?: "info" | "warning" | "error") =>
      ctx.ui?.notify?.(message, type ?? "info");

    if (!turn.fromWechat) {
      // 终端 turn：无需提取回复 / 元信息（避免无谓的分支扫描）。
      await reply.handleSettled({
        fromWechat: false,
        requestId: null,
        replyText: null,
        metaText: null,
        notify,
      });
      return;
    }

    // 提取本轮最终回复（branch 中最后一条有文本的 assistant 消息）与模型元信息。
    const replyText = extractLastReply(ctx);
    const metaText = replyText ? meta.buildMetaInfo(ctx) : null;
    await reply.handleSettled({
      fromWechat: true,
      requestId: turn.requestId,
      replyText,
      metaText,
      notify,
    });
  });
}
