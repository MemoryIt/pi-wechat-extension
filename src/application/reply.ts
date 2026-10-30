/**
 * reply.ts - 回复发送用例（应用层）
 *
 * 承载 `agent_settled` 的「发送决策」：
 * - 终端 turn：释放 terminal 标志，最终 `onAiDone()`；
 * - 微信 turn：requestId 防重 → 提取回复 → 停止 typing → 发送 → 成功后标记已处理；
 * - 发送失败不标记（可重试，D2）；所有路径 `finally` 调 `onAiDone()`（D1）。
 *
 * 只依赖 `./types.js`（DTO / 窄端口）与 `../shared/logger.js`，不感知 pi / Channel / vendor。
 */

import type { PluginLogger } from "../shared/logger.js";
import type { ReplyChannel, SettledContext } from "./types.js";

export class ReplyService {
  private readonly channel: ReplyChannel;
  private readonly logger: PluginLogger;

  constructor(deps: { channel: ReplyChannel; logger: PluginLogger }) {
    this.channel = deps.channel;
    this.logger = deps.logger;
  }

  async handleSettled(ctx: SettledContext): Promise<void> {
    try {
      if (!ctx.fromWechat) {
        // 终端 turn：释放标志并排空队列（对缺失 agent_end 的情况也是兜底）。
        this.channel.setTerminalProcessing(false);
        return;
      }

      if (!ctx.requestId) {
        this.logger.debug(`agent_settled: WeChat turn without requestId, skip sending`);
        return;
      }

      // 防重
      if (this.channel.isRequestProcessed(ctx.requestId)) {
        this.logger.debug(`Request ${ctx.requestId} already processed, skipping`);
        return;
      }

      if (!ctx.replyText) {
        this.logger.debug(`agent_settled: no reply text found`);
        return;
      }

      // typing 兜底停止
      await this.channel.stopTyping();

      // 追加模型元信息
      const finalReply = ctx.replyText + (ctx.metaText ? "\n\n" + ctx.metaText : "");

      this.logger.debug(`Sending reply: ${ctx.replyText.slice(0, 50)}...`);

      try {
        await this.channel.sendReply(finalReply);
        // 只有发送成功后才标记已处理，失败时仍可重试（D2）。
        this.channel.markRequestProcessed(ctx.requestId);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send reply:`, errMsg);
        ctx.notify(`微信回复失败: ${errMsg}`, "error");
      }
    } finally {
      // 所有早退 / 异常路径都必须释放队列，否则后续微信消息会永久停滞（D1）。
      this.channel.onAiDone();
    }
  }
}
