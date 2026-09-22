/**
 * events.ts - 事件桥接
 *
 * 从 index.ts 拆出：注册所有 `pi.on(...)` 处理器以及 `handleWechatSettled`。
 *
 * 事件桥接的核心约定：
 * - 每轮 turn 的身份（`{ fromWechat, requestId }`）都在事件发生时通过
 *   `resolveTurnBeforeRun()` / `resolveTurnFromBranch()` 从 session 中同步解析，
 *   并显式传给处理函数。
 * - 最终回复在 `agent_settled` 发送（一轮 prompt 只发一次，覆盖重试/压缩/续跑后的最终版）；
 *   `agent_end` 只负责 typing 收敛与终端标志兜底。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultAccountToken } from "../storage/state.js";
import { setConfig } from "../engine/wechat.js";
import type { WechatEngine } from "../engine/wechat.js";
import { isDebugEnabled } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import {
  pushPendingWechatInput,
  resolveTurnBeforeRun,
  resolveTurnFromBranch,
  isAssistantMessage,
  extractLastReply,
  type WechatTurn,
} from "./turn.js";
import { buildMetaInfo, refreshCachedGitBranch } from "./meta.js";

const logger = createLogger({ isDebugEnabled: () => isDebugEnabled() });

export function registerBridge(pi: ExtensionAPI, engine: WechatEngine): void {
  // ============== session_start ==============

  pi.on("session_start", async (_event, ctx) => {
    // 不再用空 render 覆盖内置 footer；分支名通过 pi.exec 获取。
    await refreshCachedGitBranch(pi);

    // B4：会话过期（needs_relogin）时通过 UI 通知用户
    engine.setNotifier((msg, type) => ctx.ui.notify(msg, type ?? "info"));

    const token = await getDefaultAccountToken();
    if (token) {
      setConfig({ baseUrl: token.baseUrl, token: token.botToken });
      logger.debug(`session_start: loaded token for userId=${token.userId}`);

      // 启动轮询
      engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken }).catch((err) => {
        logger.error("Polling error:", err.message);
      });
    } else {
      logger.debug(`session_start: no logged in account found`);
    }
  });

  // ============== session_shutdown ==============

  pi.on("session_shutdown", async () => {
    engine.stopPolling();
    engine.reset();
  });

  // ============== input ==============
  // pi.sendUserMessage 注入时 source === "extension"。把待处理微信消息文本入队，
  // 供 before_agent_start 在无法从 session 判断来源时用 event.prompt 兜底匹配。
  pi.on("input", (event, ctx) => {
    const inputEvent = event as { source?: string; text?: string };
    if (inputEvent.source !== "extension") return { action: "continue" };

    const turn = resolveTurnBeforeRun(ctx);
    if (turn.fromWechat) {
      pushPendingWechatInput({ requestId: turn.requestId, text: inputEvent.text ?? "" });
    }
    return { action: "continue" };
  });

  // ============== before_agent_start ==============

  pi.on("before_agent_start", async (event, ctx) => {
    // 同步捕获本轮 turn 的身份，不做任何延迟。
    // 此刻当前 user 消息尚未写入分支（pi 在 before_agent_start 之后才 append），
    // 因此用「最近一条 wechat_meta 是否位于最后一条 assistant 之后」判断。
    const turn = resolveTurnBeforeRun(ctx, (event as { prompt?: string }).prompt);
    if (turn.fromWechat) {
      logger.debug(`before_agent_start: WeChat turn detected, requestId=${turn.requestId ?? "(unknown)"}`);
    } else {
      // 终端消息正在处理，微信消息需要排队
      engine.setTerminalProcessing(true);
      logger.debug(`before_agent_start: Terminal turn, WeChat messages will be queued`);
    }
  });

  // ============== message_start / message_end（typing）==============
  // 只在 assistant 消息上开启 / 停止 typing；user / toolResult 的结束不得提前关闭。

  pi.on("message_start", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    logger.debug(`message_start: starting typing keepalive`);
    await engine.startTypingKeepalive();
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    logger.debug(`message_end: stopping typing keepalive`);
    await engine.stopTypingKeepalive();
  });

  // ============== agent_end ==============
  // 只用于 typing 收敛（以及终端标志兜底），最终回复统一在 agent_settled 发送。

  pi.on("agent_end", async (_event, ctx) => {
    const turn = resolveTurnFromBranch(ctx);
    if (turn.fromWechat) {
      await engine.stopTypingKeepalive();
    } else {
      engine.setTerminalProcessing(false);
    }
  });

  // ============== agent_settled ==============

  pi.on("agent_settled", async (_event, ctx) => {
    // 每轮结束时的可靠信号：pi 不会再有自动重试 / 压缩 / 续跑。
    const turn = resolveTurnFromBranch(ctx);

    if (!turn.fromWechat) {
      // 终端 turn：释放标志并排空队列（对缺失 agent_end 的情况也是兜底）。
      engine.setTerminalProcessing(false);
      engine.onAiDone();
      return;
    }

    await handleWechatSettled(ctx, turn);
  });

  // ============== agent_settled 处理函数 ==============

  async function handleWechatSettled(ctx: ExtensionContext, turn: WechatTurn): Promise<void> {
    try {
      if (!turn.requestId) {
        logger.debug(`agent_settled: WeChat turn without requestId, skip sending`);
        return;
      }

      // 防重
      if (engine.isRequestProcessed(turn.requestId)) {
        logger.debug(`Request ${turn.requestId} already processed, skipping`);
        return;
      }

      // 提取本轮最终回复（branch 中最后一条有文本的 assistant 消息）
      const replyText = extractLastReply(ctx);
      if (!replyText) {
        logger.debug(`agent_settled: no reply text found`);
        return;
      }

      // typing 兜底停止
      await engine.stopTypingKeepalive();

      // 追加模型元信息
      const metaInfo = buildMetaInfo(ctx);
      const finalReply = replyText + (metaInfo ? "\n\n" + metaInfo : "");

      logger.debug(`Sending reply: ${replyText.slice(0, 50)}...`);

      try {
        await engine.sendMessageWithRetry(finalReply);
        // 只有发送成功后才标记已处理，失败时仍可重试（D2）。
        engine.markRequestProcessed(turn.requestId);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to send reply:`, errMsg);
        ctx.ui?.notify?.(`微信回复失败: ${errMsg}`, "error");
      }
    } finally {
      // 所有早退 / 异常路径都必须释放队列，否则后续微信消息会永久停滞（D1）。
      engine.onAiDone();
    }
  }
}
