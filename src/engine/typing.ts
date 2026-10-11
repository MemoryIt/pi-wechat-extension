/**
 * typing.ts - Typing 指示灯控制器（单用户）
 *
 * 负责 typing 指示灯状态：
 * - typing_ticket 按 contextToken + TTL 缓存，contextToken 变化时旧 ticket 失效
 * - keepalive timer 间隔 8000ms 且 unref
 * - 发送报错信息含 "ticket" 时清空缓存
 *
 * 微信边界经 `TypingDeps.outbound` 端口访问；缓存/失效策略仍留在本类。
 * 最初自 wechat.ts 提取，行为保持不变。
 */

import type { WechatOutbound } from "../ports/outbound.js";

export interface TypingDeps {
  /** 出站端口：getTypingTicket / sendTyping（端口本身无缓存）。 */
  outbound: WechatOutbound;
  /** 当前 contextToken，用于 ticket 缓存绑定；缺失时视为无凭证。 */
  getContextToken(): string | null;
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const TYPING_KEEPALIVE_INTERVAL_MS = 8000;
const TYPING_TICKET_CACHE_TTL_MS = 60_000;

export class TypingController {
  private typingTicketCache: {
    ticket: string;
    expiresAt: number;
    contextToken: string;
  } | null = null;
  private typingKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: TypingDeps) {}

  /**
   * 获取 typing_ticket（单用户）
   */
  async getTicket(): Promise<string | null> {
    const contextToken = this.deps.getContextToken();
    if (!contextToken) {
      return null;
    }

    // 检查缓存：必须与当前 contextToken 匹配，token 变化后旧 ticket 失效
    if (
      this.typingTicketCache &&
      this.typingTicketCache.contextToken === contextToken &&
      Date.now() < this.typingTicketCache.expiresAt
    ) {
      return this.typingTicketCache.ticket;
    }

    const ticket = await this.deps.outbound.getTypingTicket();
    if (ticket) {
      this.typingTicketCache = {
        ticket,
        expiresAt: Date.now() + TYPING_TICKET_CACHE_TTL_MS,
        contextToken,
      };
      return ticket;
    }

    return null;
  }

  /**
   * 发送 typing 状态（单用户）
   */
  async sendStatus(status: 1 | 2): Promise<void> {
    // 凭证（contextToken）缺失时静默返回，不触发底层请求
    if (!this.deps.getContextToken()) {
      return;
    }

    const ticket = await this.getTicket();
    if (!ticket) {
      this.deps.error(`[Wechat] sendTypingStatus: failed to get typing_ticket`);
      return;
    }

    try {
      await this.deps.outbound.sendTyping(status, ticket);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.error(`[Wechat] sendTypingStatus failed:`, errMsg);
      if (errMsg.includes("ticket")) {
        this.typingTicketCache = null;
      }
    }
  }

  /**
   * 开始 typing keepalive（单用户）
   */
  async startKeepalive(): Promise<void> {
    await this.stopKeepalive();

    this.deps.debug(`startTypingKeepalive: interval=${TYPING_KEEPALIVE_INTERVAL_MS}ms`);
    await this.sendStatus(1);

    const timer = setInterval(async () => {
      await this.sendStatus(1);
    }, TYPING_KEEPALIVE_INTERVAL_MS);

    // 不要让 keepalive timer 阻止进程退出
    timer.unref?.();

    this.typingKeepaliveTimer = timer;
  }

  /**
   * 停止 typing keepalive（单用户）
   */
  async stopKeepalive(): Promise<void> {
    if (this.typingKeepaliveTimer) {
      clearInterval(this.typingKeepaliveTimer);
      this.typingKeepaliveTimer = null;
    }
  }

  /**
   * contextToken 变化时调用：使旧 ticket 立即失效
   */
  invalidateTicket(): void {
    this.typingTicketCache = null;
  }

  /**
   * 重置：停止 keepalive + 清空缓存
   */
  reset(): void {
    void this.stopKeepalive();
    this.typingTicketCache = null;
  }
}
