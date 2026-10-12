/**
 * types.ts - 应用层用例的输入 DTO 与窄端口
 *
 * `bridge` 负责把 pi 事件翻译成 `SettledContext`（纯数据 + notify 回调），
 * `application` 只依赖这里定义的窄接口做出发送决策，不感知 pi / Channel / vendor。
 */

/**
 * `agent_settled` 时刻的发送上下文。
 *
 * - `fromWechat=false` 表示终端 turn（不发送，只需释放队列）。
 * - `replyText` / `metaText` 由 bridge 从 session 分支与模型信息提取后填入。
 * - `notify` 是 UI 通知回调，由 bridge 绑定 `ctx.ui.notify`。
 */
export interface SettledContext {
  fromWechat: boolean;
  requestId: string | null;
  replyText: string | null;
  metaText: string | null;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** `ReplyService` 所需的最小 Channel 能力（窄接口）。 */
export interface ReplyChannel {
  isRequestProcessed(id: string): boolean;
  stopTyping(): Promise<void>;
  sendReply(text: string, maxRetries?: number): Promise<void>;
  markRequestProcessed(id: string): void;
  setTerminalProcessing(value: boolean): void;
  onAiDone(): void;
}
