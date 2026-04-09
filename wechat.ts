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
import { getUpdates, sendMessage, sendTyping } from "./api/api";
import { ConnectionState } from "./types.js";
import * as storage from "./storage/state.js";
import { randomUUID } from "node:crypto";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// 全局 pi 实例（由 setPi 注入）
let pi: ExtensionAPI;

// 全局配置（由 setConfig 注入）
interface WechatConfig {
  baseUrl: string;
  token: string;
}
let wechatConfig: WechatConfig | null = null;

export function setConfig(config: WechatConfig): void {
  wechatConfig = config;
}

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

  // === Phase 3c: 回复发送状态 ===
  // 当前请求 ID（闭包变量，供 agent_end 使用）
  private currentRequestId: string | null = null;

  // 已处理的请求 ID + timestamp（用于防重 + 定期清理）
  private processedRequests = new Map<string, number>();

  // processedRequests 清理计数器
  private cleanupCounter = 0;

  // === Phase 3b: 消息队列状态 ===
  // 消息队列：同一用户的多条消息排队（存储 msg + requestId）
  private pendingMessages = new Map<string, Array<{ msg: WeixinMessage; requestId: string }>>();

  // AI 是否正在处理（防止并发）
  private isAiProcessing = false;

  // 当前处理的 userId（闭包变量，供 agent_end 使用）
  private currentUserId: string | null = null;

  // 用户上下文映射（持久化到磁盘）
  private userContexts = new Map<string, { userId: string; contextToken: string; displayName: string }>();

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
   * 获取用户上下文映射（用于遍历查找）
   */
  getUserContexts(): Map<string, { userId: string; contextToken: string; displayName: string }> {
    return this.userContexts;
  }

  /**
   * 获取当前用户 ID
   */
  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  /**
   * 获取当前请求 ID
   */
  getCurrentRequestId(): string | null {
    return this.currentRequestId;
  }

  /**
   * 设置用户上下文（用于 before_agent_start 保存）
   */
  setCurrentRequest(requestId: string | null, userId: string | null): void {
    this.currentRequestId = requestId;
    this.currentUserId = userId;
  }

  /**
   * 发送 typing 状态
   */
  async sendTypingStatus(userId: string, contextToken: string, status: 1 | 2): Promise<void> {
    if (!wechatConfig) return;
    try {
      await sendTyping({
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: contextToken,
          status, // 1=TYPING, 2=CANCEL
        },
      });
    } catch (err) {
      console.error(`[Wechat] sendTyping failed:`, err);
    }
  }

  /**
   * 发送消息到微信（带重试）
   */
  async sendMessageWithRetry(
    toUserId: string,
    contextToken: string,
    text: string,
    maxRetries: number = 3
  ): Promise<void> {
    if (!wechatConfig) {
      throw new Error("Wechat config not set");
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 构建完整的消息对象（grok 指出需要这些必填字段）
        const msg: WeixinMessage = {
          from_user_id: "",           // 必须为空，表示机器人发送
          to_user_id: toUserId,        // 目标用户 ID
          client_id: randomUUID(),     // 每条消息唯一，用于去重和路由
          message_type: 2,             // 2 = BOT（机器人消息）
          message_state: 2,            // 2 = FINISH（完成）
          context_token: contextToken, // 会话上下文 token
          item_list: [{ type: 1, text_item: { text } }], // 文本消息
        };

        await sendMessage({
          baseUrl: wechatConfig.baseUrl,
          token: wechatConfig.token,
          body: { msg },
        });
        console.log(`[Wechat] Message sent to ${toUserId}`);
        return;
      } catch (err: any) {
        lastError = err;
        console.error(`[Wechat] sendMessage attempt ${attempt} failed:`, err.message);
        if (attempt < maxRetries) {
          // 指数退避：1s, 2s, 4s
          await this.sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
    }

    throw lastError ?? new Error("sendMessage failed");
  }

  /**
   * 清理旧的 processedRequests（1 小时前）
   */
  cleanupProcessedRequests(): void {
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, timestamp] of this.processedRequests) {
      if (timestamp < oneHourAgo) {
        this.processedRequests.delete(id);
      }
    }
    this.cleanupCounter = 0;
    console.log(`[Wechat] Cleaned up processedRequests, remaining: ${this.processedRequests.size}`);
  }

  /**
   * 检查请求是否已处理
   */
  isRequestProcessed(requestId: string): boolean {
    return this.processedRequests.has(requestId);
  }

  /**
   * 标记请求已处理
   */
  markRequestProcessed(requestId: string): void {
    this.processedRequests.set(requestId, Date.now());
    this.cleanupCounter++;

    // 每 50 次处理清理一次
    if (this.cleanupCounter >= 50) {
      this.cleanupProcessedRequests();
    }
  }

  /**
   * 清理所有状态（session_shutdown 时调用）
   */
  reset(): void {
    this.pendingMessages.clear();
    this.processedRequests.clear();
    this.currentUserId = null;
    this.currentRequestId = null;
    this.isAiProcessing = false;
    this.cleanupCounter = 0;
    this.abortController = new AbortController(); // 重建（新 abort signal）
    console.log("[Wechat] Engine state reset");
  }

  /**
   * 触发 AI 处理（内部方法）
   */
  private async triggerAiForUser(userId: string, msg: WeixinMessage, requestId: string): Promise<void> {
    this.currentUserId = userId;
    this.currentRequestId = requestId;
    this.isAiProcessing = true;

    // 格式化消息
    const formatted = this.formatWechatMessage(msg, requestId);

    // 写入 wechat_meta 隐藏消息（用于 agent_end 追踪）
    (pi.appendEntry as any)("wechat_meta", {
      requestId,
      userId,
      timestamp: Date.now(),
    });

    // 通过 pi 发送用户消息，触发 AI 回复
    // sendUserMessage 会自动触发 LLM turn
    // 注意：agent_end 回调中调用 sendUserMessage 有时序问题
    // 使用 followUp 让消息在 agent 完全结束后再触发
    (pi.sendUserMessage as any)(formatted, {
      deliverAs: "followUp",
    });
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
            this.currentRequestId = null;
          }
          processed = true;
          break;
        }
      }

      // 没有更多消息，退出循环
      if (!processed) {
        this.isAiProcessing = false;
        this.currentUserId = null;
        this.currentRequestId = null;
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

    // 如果有 context_token，更新用户上下文
    if (msg.context_token) {
      const existing = this.userContexts.get(msg.from_user_id ?? "");
      this.userContexts.set(msg.from_user_id ?? "", {
        userId: msg.from_user_id ?? "",
        contextToken: msg.context_token,
        displayName: existing?.displayName ?? msg.from_user_id ?? "unknown",
      });
    }

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
