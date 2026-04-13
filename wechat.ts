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
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { WeixinMessage, MessageItem, ImageItem } from "./api/types";
import { getUpdates, sendMessage, sendTyping, getConfig } from "./api/api.js";
import { ConnectionState } from "./types.js";
import * as storage from "./storage/state.js";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { downloadAndDecryptBuffer } from "./cdn/pic-decrypt.js";
import crypto from "node:crypto";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// === 图片存储配置 ===
const MEDIA_STORAGE_DIR = join(getAgentDir(), "wechat", "media", "inbound");

function ensureMediaDir(): void {
  if (!existsSync(MEDIA_STORAGE_DIR)) {
    mkdirSync(MEDIA_STORAGE_DIR, { recursive: true });
  }
}

/**
 * 保存图片到本地存储
 * @param buffer 图片数据
 * @param ext 文件扩展名
 * @returns 保存后的文件路径
 */
function saveImageToStorage(buffer: Buffer, ext: string = ".jpg"): string {
  ensureMediaDir();
  const filename = `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const filepath = join(MEDIA_STORAGE_DIR, filename);
  writeFileSync(filepath, buffer);
  return filepath;
}

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

  // 当前 API 配置（用于消息队列处理）
  private currentOpts: { baseUrl: string; token: string } | null = null;

  // AI 处理完成回调（由 agent_end 事件调用）
  private onAiProcessingDone: (() => void) | null = null;

  // === Typing 相关状态 ===
  // typing_ticket 缓存（60秒）
  private typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();

  // typing keepalive 定时器
  private typingKeepaliveTimers = new Map<string, NodeJS.Timeout>();

  // typing keepalive 间隔（8秒）
  private readonly TYPING_KEEPALIVE_INTERVAL_MS = 8000;

  // typing_ticket 缓存有效期（60秒）
  private readonly TYPING_TICKET_CACHE_TTL_MS = 60_000;

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

    // === 纯图片消息拦截 ===
    const hasText = msg.item_list?.some(item => item.type === 1 && item.text_item?.text?.trim());
    const hasImage = msg.item_list?.some(item => item.type === 2);

    if (hasImage && !hasText) {
      console.log(`[Wechat] Pure image message detected, downloading and acknowledging...`);

      // 下载图片（保留，用于后续分析）
      for (const item of msg.item_list ?? []) {
        if (item.type === 2 && item.image_item) {
          const imagePath = await this.downloadImage(item.image_item, opts.baseUrl, opts.token);
          if (imagePath) {
            console.log(`[Wechat] Image saved: ${imagePath}`);
          }
        }
      }

      // 获取用户上下文用于发送回复
      const userCtx = this.userContexts.get(userId);
      const contextToken = userCtx?.contextToken || msg.context_token || "";

      // 直接返回"已收到"
      try {
        await sendMessage({
          baseUrl: opts.baseUrl,
          token: opts.token,
          body: {
            msg: {
              to_user_id: userId,
              context_token: contextToken,
              item_list: [{ type: 1, text_item: { text: "已收到" } }],
            },
          },
        });
        console.log(`[Wechat] Image acknowledged to user ${userId}`);
      } catch (err) {
        console.error(`[Wechat] Failed to send image acknowledgment:`, err);
      }

      return; // 不触发 AI
    }

    // 触发 AI 处理
    await this.triggerAi(userId, msg, requestId, opts);
  }

  /**
   * 触发 AI 处理微信消息
   * 如果 AI 正在处理，将消息加入队列
   */
  async triggerAi(userId: string, msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    // 如果当前正在处理该用户，加入队列
    if (this.isAiProcessing && this.currentUserId === userId) {
      const queue = this.pendingMessages.get(userId) ?? [];
      queue.push({ msg, requestId });
      this.pendingMessages.set(userId, queue);
      console.log(`[Wechat] User ${userId} is processing, queued message (queue size: ${queue.length})`);
      return;
    }

    // 触发 AI 处理
    await this.triggerAiForUser(userId, msg, requestId, opts);
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
   * 获取 typing_ticket（带 60 秒缓存）
   * @param userId 用户 ID
   * @param contextToken 会话上下文 token
   * @returns typing_ticket 或 null
   */
  async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    if (!wechatConfig) {
      console.error(`[Wechat] getTypingTicket: wechatConfig is null`);
      return null;
    }

    // 检查缓存
    const cached = this.typingTicketCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[Wechat] getTypingTicket: using cached ticket for userId=${userId}`);
      return cached.ticket;
    }

    // 缓存过期或不存在，需要重新获取
    console.log(`[Wechat] getTypingTicket: fetching new ticket for userId=${userId}`);

    try {
      const configResp = await getConfig({
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        ilinkUserId: userId,
        contextToken: contextToken,
      });

      if (configResp.ret === 0 && configResp.typing_ticket) {
        // 缓存新 ticket
        this.typingTicketCache.set(userId, {
          ticket: configResp.typing_ticket,
          expiresAt: Date.now() + this.TYPING_TICKET_CACHE_TTL_MS,
        });
        console.log(`[Wechat] getTypingTicket: got new ticket for userId=${userId}, cached for 60s`);
        return configResp.typing_ticket;
      } else {
        console.error(`[Wechat] getTypingTicket: failed for userId=${userId}, ret=${configResp.ret}, errmsg=${configResp.errmsg}`);
        return null;
      }
    } catch (err: any) {
      console.error(`[Wechat] getTypingTicket: error for userId=${userId}:`, err.message);
      return null;
    }
  }

  /**
   * 发送 typing 状态
   * @param userId 用户 ID
   * @param contextToken 会话上下文 token
   * @param status 1=TYPING, 2=CANCEL
   */
  async sendTypingStatus(userId: string, contextToken: string, status: 1 | 2): Promise<void> {
    const now = new Date().toISOString();

    if (!wechatConfig) {
      console.error(`[Wechat] [${now}] sendTypingStatus: wechatConfig is null`);
      return;
    }

    const statusStr = status === 1 ? "TYPING" : "CANCEL";

    // 获取 typing_ticket（带 60 秒缓存）
    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) {
      console.error(`[Wechat] [${now}] sendTypingStatus: failed to get typing_ticket for userId=${userId}`);
      return;
    }

    try {
      await sendTyping({
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status,
        },
      });
      console.log(`[Wechat] [${now}] sendTypingStatus: ${statusStr} sent for userId=${userId}`);
    } catch (err: any) {
      console.error(`[Wechat] [${now}] sendTypingStatus: ${statusStr} failed:`, err.message);

      // 如果失败，清除缓存，下次重试
      if (err.message?.includes("ticket")) {
        this.typingTicketCache.delete(userId);
        console.log(`[Wechat] [${now}] sendTypingStatus: cleared cache for userId=${userId}`);
      }
    }
  }

  /**
   * 开始 typing keepalive（每 8 秒刷新一次）
   */
  async startTypingKeepalive(userId: string, contextToken: string): Promise<void> {
    // 先停止已有的 keepalive
    await this.stopTypingKeepalive(userId);

    const now = new Date().toISOString();
    console.log(`[Wechat] [${now}] startTypingKeepalive: userId=${userId}, interval=${this.TYPING_KEEPALIVE_INTERVAL_MS}ms`);

    // 立即发送一次 typing=1
    await this.sendTypingStatus(userId, contextToken, 1);

    // 设置定时器，每 8 秒刷新一次
    const timer = setInterval(async () => {
      const tickNow = new Date().toISOString();
      console.log(`[Wechat] [${tickNow}] KEEPALIVE_TICK: sending typing=1 for userId=${userId}`);
      await this.sendTypingStatus(userId, contextToken, 1);
    }, this.TYPING_KEEPALIVE_INTERVAL_MS);

    this.typingKeepaliveTimers.set(userId, timer);
  }

  /**
   * 停止 typing keepalive
   */
  async stopTypingKeepalive(userId: string): Promise<void> {
    const timer = this.typingKeepaliveTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.typingKeepaliveTimers.delete(userId);
      console.log(`[Wechat] [${new Date().toISOString()}] stopTypingKeepalive: stopped for userId=${userId}`);
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
    // 停止所有 typing keepalive
    for (const [userId] of this.typingKeepaliveTimers) {
      this.stopTypingKeepalive(userId);
    }
    this.typingKeepaliveTimers.clear();
    this.typingTicketCache.clear();

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
  private async triggerAiForUser(userId: string, msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    this.currentUserId = userId;
    this.currentRequestId = requestId;
    this.isAiProcessing = true;
    this.currentOpts = opts; // 保存当前配置供消息队列使用

    // 检查用户上下文
    const userCtx = this.userContexts.get(userId);
    console.log(`[Wechat] triggerAiForUser: userId=${userId}, contextToken=${userCtx?.contextToken ? 'present' : 'MISSING'}, displayName=${userCtx?.displayName ?? 'unknown'}`);

    // 格式化消息（异步，支持图片下载）
    const formatted = await this.formatWechatMessage(msg, requestId, opts);

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
   * 使用 safelyTriggerNext 避免 agent_end 时序问题
   */
  onAiDone(): void {
    const userId = this.currentUserId;
    this.isAiProcessing = false;
    this.currentUserId = null;
    this.currentRequestId = null;

    // 安全地处理队列中的下一条消息
    if (userId) {
      this.safelyTriggerNext(userId);
    }
  }

  /**
   * 安全地触发下一条消息处理
   * 使用 setTimeout(20ms) 避免 agent_end 时序问题
   * 带重试机制，指数退避
   */
  private safelyTriggerNext(userId: string, retryCount = 0): void {
    const MAX_RETRY = 3;
    const BASE_DELAY = 20;

    setTimeout(() => {
      const queue = this.pendingMessages.get(userId);
      if (!queue?.length) {
        // 队列为空，重置状态
        this.isAiProcessing = false;
        return;
      }

      try {
        // 先 peek，不 shift（成功后再移除）
        const { msg, requestId } = queue[0];
        console.log(`[Wechat] Safely triggering next message for user ${userId} (retry: ${retryCount})`);
        
        // 使用保存的 currentOpts
        if (!this.currentOpts) {
          console.error(`[Wechat] safelyTriggerNext: currentOpts is null, cannot process queue`);
          queue.shift();
          this.isAiProcessing = false;
          this.safelyTriggerNext(userId);
          return;
        }
        
        this.triggerAiForUser(userId, msg, requestId, this.currentOpts);
        queue.shift(); // 成功发送后再移除
      } catch (err: any) {
        if (err.message?.includes("already processing") && retryCount < MAX_RETRY) {
          console.warn(`[Wechat] Agent still busy, retry ${retryCount + 1}/${MAX_RETRY}`);
          this.safelyTriggerNext(userId, retryCount + 1);
        } else {
          // 彻底失败：移除并记录
          queue.shift();
          console.error(`[Wechat] Failed to process queued message: ${err.message}`);
          // 重置状态，尝试处理队列中的下一条
          this.isAiProcessing = false;
          this.safelyTriggerNext(userId);
        }
      }
    }, BASE_DELAY * Math.pow(1.5, retryCount)); // 20 → 30 → 45ms
  }

  /**
   * 下载并解密微信图片
   * @param img ImageItem
   * @param baseUrl API base URL
   * @param token Bot token
   * @returns 保存后的本地路径，失败返回 null
   */
  /**
   * 解析 AES key 支持多种格式
   * @param aesKeyInput aeskey (32 char hex) 或 aes_key (base64)
   * @returns 16 字节 AES key
   */
  private parseAesKey(aesKeyInput: string): Buffer | null {
    if (!aesKeyInput) return null;

    const trimmed = aesKeyInput.trim();

    // Case 1: 直接 32 字符 hex（image_item.aeskey 最常见）
    if (trimmed.length === 32 && /^[0-9a-fA-F]{32}$/.test(trimmed)) {
      console.log(`[Wechat] parseAesKey: using hex format`);
      return Buffer.from(trimmed, "hex");
    }

    // Case 2: Base64 编码
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 16) {
        console.log(`[Wechat] parseAesKey: using base64 raw 16 bytes`);
        return decoded;
      }
      // 如果是 24 字节，可能是 hex 再 base64
      if (decoded.length === 24) {
        const hexStr = decoded.toString("utf8").trim();
        if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
          console.log(`[Wechat] parseAesKey: using base64(hex) -> hex`);
          return Buffer.from(hexStr, "hex");
        }
      }
    } catch {
      // ignore
    }

    console.warn(`[Wechat] parseAesKey: unsupported format, len=${trimmed.length}`);
    return null;
  }

  /**
   * 下载并解密微信图片
   * @param img ImageItem
   * @param baseUrl API base URL
   * @param token Bot token
   * @returns 保存后的本地路径，失败返回 null
   */
  async downloadImage(
    img: ImageItem,
    baseUrl: string,
    token: string
  ): Promise<string | null> {
    try {
      // 优先使用缩略图（更快），其次原图
      const target = img.thumb_media || img.media;
      const fullUrl = target?.full_url;

      // 优先使用 image_item.aeskey（32 char hex），其次 media.aes_key（base64）
      const aesKeyRaw = img.aeskey || img.media?.aes_key;

      if (!fullUrl || !aesKeyRaw) {
        console.warn(`[Wechat] Image download: missing URL or AES key, fullUrl=${!!fullUrl}, aesKey=${!!aesKeyRaw}`);
        return null;
      }

      // 解析 AES key
      const aesKey = this.parseAesKey(aesKeyRaw);
      if (!aesKey) {
        console.error(`[Wechat] Image download: failed to parse aesKey`);
        return null;
      }

      console.log(`[Wechat] Downloading image: fullUrl=${fullUrl.substring(0, 80)}...`);

      // 下载加密数据
      let encrypted: Buffer;
      try {
        const res = await fetch(fullUrl);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        encrypted = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        console.error(`[Wechat] Image download: fetch failed:`, err);
        return null;
      }

      console.log(`[Wechat] Image download: downloaded ${encrypted.length} bytes, decrypting...`);

      // AES-128-ECB 解密
      const decrypted = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
      const final = Buffer.concat([decrypted.update(encrypted), decrypted.final()]);

      // 保存到本地
      const savedPath = saveImageToStorage(final, ".jpg");
      console.log(`[Wechat] Image saved: ${savedPath} (${final.length} bytes)`);
      return savedPath;

    } catch (err) {
      console.error(`[Wechat] Image download failed:`, err);
      return null;
    }
  }

  /**
   * 格式化微信消息为 pi 可处理的格式
   * 格式: __WECHAT_REQ_{requestId}__[WeChat; {displayName}] {content}
   */
  async formatWechatMessage(msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<string> {
    const userLabel = `[WeChat; ${msg.from_user_id ?? "unknown"}]`;

    const parts: string[] = [];

    // 如果有 context_token，更新用户上下文
    if (msg.context_token) {
      console.log(`[Wechat] formatWechatMessage: received context_token for user ${msg.from_user_id}: ${msg.context_token.substring(0, 30) ?? 'null'}...`);
      const existing = this.userContexts.get(msg.from_user_id ?? "");
      const newCtx = {
        userId: msg.from_user_id ?? "",
        contextToken: msg.context_token,
        displayName: existing?.displayName ?? msg.from_user_id ?? "unknown",
      };
      this.userContexts.set(msg.from_user_id ?? "", newCtx);
      console.log(`[Wechat] formatWechatMessage: userContext updated, contextToken=${newCtx.contextToken ? 'present' : 'MISSING'}`);

      // 异步持久化 context token 到磁盘
      this.persistContextToken(msg.from_user_id ?? "", newCtx.displayName, newCtx.contextToken);
    } else {
      console.log(`[Wechat] formatWechatMessage: NO context_token in message for user ${msg.from_user_id}`);
      // 检查是否有已存储的 context token
      const existing = this.userContexts.get(msg.from_user_id ?? "");
      if (existing) {
        console.log(`[Wechat] formatWechatMessage: using existing contextToken=${existing.contextToken ? 'present' : 'MISSING'} from memory`);
      } else {
        console.warn(`[Wechat] formatWechatMessage: no contextToken available for user ${msg.from_user_id}`);
      }
    }

    for (const item of msg.item_list ?? []) {
      switch (item.type) {
        case 1: // TEXT
          parts.push(item.text_item?.text ?? "");
          break;
        case 2: // IMAGE
          const imagePath = await this.downloadImage(item.image_item!, opts.baseUrl, opts.token);
          if (imagePath) {
            parts.push(`[image:${imagePath}]`);
          } else {
            parts.push("[📷 图片下载失败]");
          }
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
   * 异步持久化 context token 到磁盘
   */
  private async persistContextToken(userId: string, displayName: string, contextToken: string): Promise<void> {
    if (!this.accountId) return;
    try {
      await storage.saveContextToken(this.accountId, userId, {
        displayName,
        contextToken,
        lastMessageAt: Date.now(),
      });
    } catch (err) {
      console.error(`[Wechat] persistContextToken failed:`, err);
    }
  }

  /**
   * 加载持久化的 context tokens
   */
  async loadPersistedContextTokens(): Promise<void> {
    if (!this.accountId) return;
    try {
      const tokens = await storage.loadContextTokens(this.accountId);
      for (const [userId, entry] of Object.entries(tokens)) {
        const existing = this.userContexts.get(userId);
        this.userContexts.set(userId, {
          userId,
          contextToken: entry.contextToken,
          displayName: entry.displayName ?? existing?.displayName ?? userId,
        });
        console.log(`[Wechat] Loaded contextToken for user ${userId}: ${entry.contextToken ? 'present' : 'MISSING'}`);
      }
      console.log(`[Wechat] Loaded ${Object.keys(tokens).length} context tokens from disk`);
    } catch (err) {
      console.error(`[Wechat] loadPersistedContextTokens failed:`, err);
    }
  }

  /**
   * 获取用户上下文
   */
  getUserContext(userId: string): { userId: string; contextToken: string; displayName: string } | undefined {
    return this.userContexts.get(userId);
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
