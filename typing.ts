/**
 * typing.ts - Typing 指示灯控制器（单用户）
 *
 * 从 wechat.ts 提取，行为保持不变：
 * - typing_ticket 按 contextToken + TTL 缓存
 * - keepalive timer 间隔 8000ms 且 unref
 * - ticket 失效/失败时清缓存
 */

import { getConfig, sendTyping } from "./api/api.js";

export interface TypingCredentials {
  baseUrl: string;
  token: string;
  userId: string;
  contextToken: string;
}

export interface TypingDeps {
  getCredentials(): TypingCredentials | null;
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
    const creds = this.deps.getCredentials();
    if (!creds) {
      return null;
    }

    // 检查缓存：必须与当前 contextToken 匹配，token 变化后旧 ticket 失效
    if (
      this.typingTicketCache &&
      this.typingTicketCache.contextToken === creds.contextToken &&
      Date.now() < this.typingTicketCache.expiresAt
    ) {
      return this.typingTicketCache.ticket;
    }

    try {
      const configResp = await getConfig({
        baseUrl: creds.baseUrl,
        token: creds.token,
        ilinkUserId: creds.userId,
        contextToken: creds.contextToken,
      });

      if (configResp.ret === 0 && configResp.typing_ticket) {
        this.typingTicketCache = {
          ticket: configResp.typing_ticket,
          expiresAt: Date.now() + TYPING_TICKET_CACHE_TTL_MS,
          contextToken: creds.contextToken,
        };
        return configResp.typing_ticket;
      }
    } catch (err) {
      this.deps.error(`[Wechat] getTypingTicket failed:`, err);
    }

    return null;
  }

  /**
   * 发送 typing 状态（单用户）
   */
  async sendStatus(status: 1 | 2): Promise<void> {
    const creds = this.deps.getCredentials();
    if (!creds) {
      return;
    }

    const ticket = await this.getTicket();
    if (!ticket) {
      this.deps.error(`[Wechat] sendTypingStatus: failed to get typing_ticket`);
      return;
    }

    try {
      await sendTyping({
        baseUrl: creds.baseUrl,
        token: creds.token,
        body: {
          ilink_user_id: creds.userId,
          typing_ticket: ticket,
          status,
        },
      });
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
