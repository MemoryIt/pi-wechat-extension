/**
 * 微信核心引擎 - Phase 3a+3b: 消息接收 + 消息队列
 * 
 * Phase 3a 核心功能：
 * - WechatEngine 基础框架
 * - startPolling()：长轮询获取消息
 * - handleMessage()：消息格式化
 * - formatWechatMessage()：生成 __WECHAT_REQ_xxx__[WeChat; name] content
 * - triggerAi()：pi.sendUserMessage({ triggerTurn: true })
 * - stopPolling()：中止轮询
 * 
 * Phase 3b 消息队列：
 * - pendingMessages: Map<userId, Array<{ msg, requestId }>>
 * - isAiProcessing: boolean
 * - handleMessage()：AI 忙时加入队列，否则直接触发
 * - triggerAi()：设置 isAiProcessing，写入 wechat_meta 隐藏消息
 * - processNextMessage()：AI 完成后取下一条处理
 * 
 * 不含：typing、agent_end 拦截（Phase 3c）
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

  // === Phase 3b: 消息队列状态 ===
  // 消息队列：同一用户的多条消息排队（存储 msg + requestId）
  private pendingMessages = new Map<string, Array<{ msg: WeixinMessage; requestId: string }>>();

  // AI 是否正在处理（防止并发）
  private isAiProcessing = false;

  // 当前处理的 userId（闭包变量，供 agent_end 使用）
  private currentUserId: string | null = null;

  // AI 处理完成回调（由 agent_end 事件调用）
  private onAiProcessingDone: (() => void) | null = null;

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
    // 立即更新状态，不用等轮询循环退出
    this.state.connectionState = "disconnected";
  }

  /**
   * 启动长轮询
   */
  async startPolling(opts: { baseUrl: string; token: string }): Promise<void> {
    // 如果之前的 AbortController 已 abort，创建新的
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
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
   * 如果 AI 正在处理，将消息加入队列
   */
  async triggerAi(userId: string, msg: WeixinMessage, requestId: string): Promise<void> {
    // 如果当前正在处理该用户，加入队列
    if (this.isAiProcessing && this.currentUserId === userId) {
      const queue = this.pendingMessages.get(userId) ?? [];
      queue.push({ msg, requestId });
      this.pendingMessages.set(userId, queue);
      console.log(`[Wechat] User ${userId} is processing, queued message (queue size: ${queue.length})`);
      return;
    }

    // 触发 AI 处理
    await this.triggerAiForUser(userId, msg, requestId);
  }

  /**
   * 触发 AI 处理（内部方法）
   */
  private async triggerAiForUser(userId: string, msg: WeixinMessage, requestId: string): Promise<void> {
    this.currentUserId = userId;
    this.isAiProcessing = true;

    // 格式化消息
    const formatted = this.formatWechatMessage(msg, requestId);
    console.log(`[Wechat] triggerAiForUser: formatted=${formatted.slice(0, 80)}...`);

    // 写入 wechat_meta 隐藏消息（用于 agent_end 追踪）
    (pi.appendEntry as any)("wechat_meta", {
      requestId,
      userId,
      timestamp: Date.now(),
    });

    // 通过 pi 发送用户消息，触发 AI 回复
    // sendUserMessage 会自动触发 LLM turn
    console.log(`[Wechat] Calling sendUserMessage with content length: ${formatted.length}`);
    (pi.sendUserMessage as any)(formatted, {
      deliverAs: "steer",
    });
    console.log(`[Wechat] sendUserMessage completed`);
  }

  /**
   * AI 处理完成回调（由 agent_end 事件调用）
   */
  onAiDone(): void {
    this.isAiProcessing = false;
    this.currentUserId = null;

    // 处理队列中的下一条消息
    this.processNextMessage();
  }

  /**
   * 处理队列中的下一条消息
   */
  private async processNextMessage(): Promise<void> {
    // 使用 while 循环避免递归栈溢出
    while (true) {
      let processed = false;

      for (const [userId, queue] of this.pendingMessages) {
        if (queue.length > 0) {
          const { msg, requestId } = queue.shift()!;
          console.log(`[Wechat] Processing queued message for user ${userId} (remaining: ${queue.length})`);

          try {
            await this.triggerAiForUser(userId, msg, requestId);
          } catch (err) {
            console.error(`[Wechat] Failed to process queued message:`, err);
            // 触发失败，重置状态并继续
            this.isAiProcessing = false;
            this.currentUserId = null;
          }
          processed = true;
          break;
        }
      }

      // 没有更多消息，退出循环
      if (!processed) {
        return;
      }
    }
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
