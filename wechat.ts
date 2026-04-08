/**
 * 微信核心引擎 - Phase 3a: 消息接收（微信 → pi 会话）
 * 
 * 核心功能：
 * - WechatEngine 基础框架
 * - startPolling()：长轮询获取消息
 * - handleMessage()：消息格式化
 * - formatWechatMessage()：生成 __WECHAT_REQ_xxx__[WeChat; name] content
 * - triggerAi()：pi.sendUserMessage({ triggerTurn: true })
 * - stopPolling()：中止轮询
 * 
 * 不含：队列、typing、agent_end 拦截
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WeixinMessage, MessageItem } from "./api/types";
import { getUpdates, sendMessage } from "./api/api";
import { ConnectionState } from "./types";
import * as storage from "./storage/state.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// 全局 pi 实例（由 setPi 注入）
let pi: ExtensionAPI;

// === 导出配置函数 ===

/**
 * 注入 pi 实例（session_start 时调用）
 */
export function setPi(piInstance: ExtensionAPI): void {
  pi = piInstance;
}

/**
 * WechatEngine - 微信核心引擎
 */
export class WechatEngine {
  // === 状态 ===
  private state: {
    syncCursor: string;
    connectionState: ConnectionState;
  } = {
    syncCursor: "",
    connectionState: "disconnected",
  };

  // 长轮询 abort signal
  private abortController = new AbortController();

  // 轮询连续失败计数
  private consecutiveFailures = 0;

  // 账号信息（运行时加载）
  private accountId: string | null = null;

  // === getter ===
  get connectionState(): ConnectionState {
    return this.state.connectionState;
  }

  get syncCursor(): string {
    return this.state.syncCursor;
  }

  // === 核心方法 ===

  /**
   * 停止长轮询
   */
  stopPolling(): void {
    this.abortController.abort();
  }

  /**
   * 启动长轮询
   */
  async startPolling(opts: { baseUrl: string; token: string }): Promise<void> {
    const abortSignal = this.abortController.signal;

    // 获取默认账号
    const tokenData = await storage.getDefaultAccountToken();
    if (!tokenData) {
      console.error("[Wechat] No logged in account found");
      return;
    }
    this.accountId = tokenData.accountId;

    // 加载持久化的 sync cursor
    this.state.syncCursor = (await storage.loadSyncCursor(this.accountId)) ?? "";

    while (!abortSignal.aborted) {
      try {
        const updates = await getUpdates({
          get_updates_buf: this.state.syncCursor,
          baseUrl: opts.baseUrl,
          token: opts.token,
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        });

        for (const msg of updates.msgs ?? []) {
          await this.handleMessage(msg, opts);
        }

        // 更新 cursor 并持久化
        this.state.syncCursor = updates.get_updates_buf ?? this.state.syncCursor;
        if (this.accountId) {
          await storage.saveSyncCursor(this.accountId, this.state.syncCursor);
        }

        // 成功，重置失败计数
        this.consecutiveFailures = 0;
        this.state.connectionState = "connected";

      } catch (error: any) {
        if (this.isSessionExpiredError(error)) {
          this.state.connectionState = "needs_relogin";
          console.error("[Wechat] Session expired, needs relogin");
          return;
        }

        this.consecutiveFailures++;
        this.state.connectionState = "error";
        console.error(`[Wechat] Poll error (attempt ${this.consecutiveFailures}):`, error.message);

        // 指数退避
        const delay = Math.min(2000 * this.consecutiveFailures, 30_000);
        await this.sleep(delay);
      }
    }

    this.state.connectionState = "disconnected";
  }

  /**
   * 处理收到的微信消息
   */
  async handleMessage(msg: WeixinMessage, opts: { baseUrl: string; token: string }): Promise<void> {
    const userId = msg.from_user_id ?? "unknown";
    const requestId = this.generateRequestId();

    // 检查是否是 slash command（目前仅 /help）
    if (this.isSlashCommand(msg)) {
      await this.handleSlashCommand(msg, opts);
      return;
    }

    // 触发 AI 处理
    await this.triggerAi(userId, msg, requestId);
  }

  /**
   * 触发 AI 处理微信消息
   */
  async triggerAi(userId: string, msg: WeixinMessage, requestId: string): Promise<void> {
    // 格式化消息
    const formatted = this.formatWechatMessage(msg, requestId);

    // 通过 pi 发送用户消息，触发 AI 回复
    // sendMessage 支持 triggerTurn: true 来触发 AI
    (pi.sendMessage as any)({
      customType: "user",
      content: formatted,
      display: "user",
    }, {
      triggerTurn: true,
      deliverAs: "steer",
    });
  }

  /**
   * 格式化微信消息为 pi 可处理的格式
   * 格式: __WECHAT_REQ_{requestId}__[WeChat; {displayName}] {content}
   */
  formatWechatMessage(msg: WeixinMessage, requestId: string): string {
    const userLabel = `[WeChat; ${msg.from_user_id ?? "unknown"}]`;

    const parts: string[] = [];

    for (const item of msg.item_list ?? []) {
      switch (item.type) {
        case 1: // TEXT
          parts.push(item.text_item?.text ?? "");
          break;
        case 2: // IMAGE
          // @ts-ignore - decryptedPath 由媒体下载模块添加
          parts.push(`[图片: ${item.image_item?.decryptedPath ?? "unknown"}]`);
          break;
        case 3: // VOICE
          // @ts-ignore - decryptedPath 由媒体下载模块添加
          parts.push(`[语音: ${item.voice_item?.decryptedPath ?? "unknown"}]`);
          break;
        case 4: // FILE
          parts.push(`[文件: ${item.file_item?.file_name ?? "unknown"}]`);
          break;
        case 5: // VIDEO
          parts.push("[视频]");
          break;
      }
    }

    return `__WECHAT_REQ_${requestId}__${userLabel} ${parts.join("\n")}`;
  }

  /**
   * 检查是否是 slash command
   */
  private isSlashCommand(msg: WeixinMessage): boolean {
    if (msg.item_list?.[0]?.type !== 1) return false;
    const text = msg.item_list[0].text_item?.text ?? "";
    return text.trim().startsWith("/");
  }

  /**
   * 处理 slash command
   */
  private async handleSlashCommand(msg: WeixinMessage, opts: { baseUrl: string; token: string }): Promise<void> {
    const text = msg.item_list?.[0]?.text_item?.text ?? "";
    const trimmed = text.trim();

    if (trimmed === "/help") {
      await sendMessage({
        baseUrl: opts.baseUrl,
        token: opts.token,
        body: {
          msg: {
            to_user_id: msg.from_user_id ?? "unknown",
            context_token: msg.context_token ?? "",
            item_list: [{ type: 1, text_item: { text: "可用命令: /help" } }],
          },
        },
      });
    }
    // TODO: /echo, /toggle-debug
  }

  /**
   * 生成请求 ID（16 字符）
   */
  private generateRequestId(): string {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6)
    ).slice(0, 16);
  }

  /**
   * 判断是否是 session 过期错误
   */
  private isSessionExpiredError(error: any): boolean {
    return error?.errcode === -14 || error?.code === -14;
  }

  /**
   * 睡眠工具
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// === 导出单例 ===
export const engine = new WechatEngine();
