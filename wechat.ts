/**
 * wechat.ts - 微信核心引擎（单用户版本）
 * 
 * 主要变化:
 * 1. 删除多用户相关逻辑 (userContexts Map, pendingMessages Map 等)
 * 2. requestId 改为精确到毫秒的时间戳格式
 * 3. 消息格式化简化为: {prefix} {content}
 * 4. 单用户固定凭证，运行时从 storage 加载
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { WeixinMessage, ImageItem } from "./api/types";
import { getUpdates, sendMessage, sendTyping, getConfig } from "./api/api.js";
import { ConnectionState } from "./types.js";
import * as storage from "./storage/state.js";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import { getPrefix } from "./config.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// ============== 图片存储配置 ==============

const MEDIA_STORAGE_DIR = join(getAgentDir(), "wechat", "media", "inbound");

function ensureMediaDir(): void {
  if (!existsSync(MEDIA_STORAGE_DIR)) {
    mkdirSync(MEDIA_STORAGE_DIR, { recursive: true });
  }
}

function saveImageToStorage(buffer: Buffer, ext: string = ".jpg"): string {
  ensureMediaDir();
  const filename = `${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const filepath = join(MEDIA_STORAGE_DIR, filename);
  writeFileSync(filepath, buffer);
  return filepath;
}

// ============== 全局变量 ==============

let pi: ExtensionAPI;

interface WechatConfig {
  baseUrl: string;
  token: string;
}
let wechatConfig: WechatConfig | null = null;

export function setConfig(config: WechatConfig): void {
  wechatConfig = config;
}

export function setPi(piInstance: ExtensionAPI): void {
  pi = piInstance;
}

// ============== WechatEngine（单用户版本）==============

export class WechatEngine {
  // === 基础状态 ===
  private state: {
    syncCursor: string;
    connectionState: ConnectionState;
  } = {
    syncCursor: "",
    connectionState: "disconnected",
  };

  private abortController = new AbortController();
  private consecutiveFailures = 0;
  private accountId: string | null = null;

  // === 单用户凭证（运行时加载）===
  private singleUserId: string | null = null;
  private singleContextToken: string | null = null;

  // === 请求追踪（仅 requestId）===
  private currentRequestId: string | null = null;
  private processedRequests = new Map<string, number>();
  private cleanupCounter = 0;

  // === AI 处理状态 ===
  private isAiProcessing = false;
  
  // === 消息队列（单用户，不需要 Map）===
  private pendingMessages: Array<{ msg: WeixinMessage; requestId: string }> = [];

  // === Typing 相关（单用户）===
  private typingTicketCache: { ticket: string; expiresAt: number } | null = null;
  private typingKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly TYPING_KEEPALIVE_INTERVAL_MS = 8000;
  private readonly TYPING_TICKET_CACHE_TTL_MS = 60_000;

  // === getter ===
  get connectionState(): ConnectionState {
    return this.state.connectionState;
  }

  // ============== 核心方法 ==============

  /**
   * 初始化单用户凭证
   * 在 session_start 时调用
   */
  async initSingleUser(): Promise<boolean> {
    // 从持久化存储加载单用户凭证
    const credentials = await storage.getSingleUserCredentials();
    if (!credentials) {
      console.error("[Wechat] No logged in account found");
      return false;
    }

    this.singleUserId = credentials.userId;
    this.accountId = credentials.accountId;

    // 加载 context token
    this.singleContextToken = await storage.getSingleUserContextToken();
    if (!this.singleContextToken) {
      console.warn("[Wechat] No context token found, replies may fail");
    }

    console.log(`[Wechat] Single user initialized: userId=${this.singleUserId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);
    return true;
  }

  /**
   * 停止长轮询
   */
  stopPolling(): void {
    this.abortController.abort();
    this.state.connectionState = "disconnected";
  }

  /**
   * 启动长轮询
   */
  async startPolling(opts: { baseUrl: string; token: string }): Promise<void> {
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    const abortSignal = this.abortController.signal;

    // 初始化单用户凭证
    if (!await this.initSingleUser()) {
      return;
    }

    // 加载 sync cursor
    this.state.syncCursor = (await storage.loadSyncCursor(this.accountId!)) ?? "";

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

        // 更新并持久化 cursor
        this.state.syncCursor = updates.get_updates_buf ?? this.state.syncCursor;
        if (this.accountId) {
          await storage.saveSyncCursor(this.accountId, this.state.syncCursor);
        }

        this.consecutiveFailures = 0;
        this.state.connectionState = "connected";

      } catch (error: unknown) {
        if (this.isSessionExpiredError(error)) {
          this.state.connectionState = "needs_relogin";
          console.error("[Wechat] Session expired, needs relogin");
          return;
        }

        this.consecutiveFailures++;
        this.state.connectionState = "error";
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Wechat] Poll error (attempt ${this.consecutiveFailures}):`, errMsg);

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
    // 单用户模式下，忽略消息来源（固定发给单用户）
    const requestId = this.generateRequestId();

    // 检查 slash command
    if (this.isSlashCommand(msg)) {
      await this.handleSlashCommand(msg, opts);
      return;
    }

    // 更新 contextToken（如果消息中有）
    if (msg.context_token && msg.context_token !== this.singleContextToken) {
      console.log(`[Wechat] Updating contextToken from message`);
      this.singleContextToken = msg.context_token;
      // 持久化
      if (this.accountId && this.singleUserId) {
        await storage.saveContextToken(this.accountId, this.singleUserId, {
          displayName: this.singleUserId,
          contextToken: msg.context_token,
          lastMessageAt: Date.now(),
        });
      }
    }

    // 纯图片消息拦截
    const hasText = msg.item_list?.some(item => item.type === 1 && item.text_item?.text?.trim());
    const hasImage = msg.item_list?.some(item => item.type === 2);

    if (hasImage && !hasText) {
      console.log(`[Wechat] Pure image message detected`);
      
      const imagePaths: string[] = [];
      for (const item of msg.item_list ?? []) {
        if (item.type === 2 && item.image_item) {
          const imagePath = await this.downloadImage(item.image_item, opts.baseUrl, opts.token);
          if (imagePath) {
            imagePaths.push(imagePath);
          }
        }
      }

      if (imagePaths.length > 0) {
        const replyText = `图片已收到，成功保存到 ${imagePaths[0]}`;
        await this.sendReplyToUser(replyText);
        
        // 加入会话历史
        const prefix = getPrefix();
        (pi.sendMessage as (msg: unknown, opts?: unknown) => Promise<void>)(
          { customType: "wechat-image-path", content: `${prefix} ${replyText}` },
          { triggerTurn: false, deliverAs: "followUp" }
        );
      }
      return;
    }

    // 触发 AI 处理
    await this.triggerAi(msg, requestId, opts);
  }

  /**
   * 触发 AI 处理消息
   * 单用户模式，无需 userId 参数
   */
  async triggerAi(msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    if (this.isAiProcessing) {
      // 加入队列
      this.pendingMessages.push({ msg, requestId });
      console.log(`[Wechat] AI is processing, queued message (queue size: ${this.pendingMessages.length})`);
      return;
    }

    await this.triggerAiInternal(msg, requestId, opts);
  }

  /**
   * 内部方法：触发 AI 处理
   */
  private async triggerAiInternal(msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    this.currentRequestId = requestId;
    this.isAiProcessing = true;

    console.log(`[Wechat] triggerAi: requestId=${requestId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);

    // 格式化消息：简化为 {prefix} {content}
    const formatted = await this.formatMessage(msg, opts);

    // 写入 wechat_meta（仅 requestId）
    (pi.appendEntry as (type: string, data: unknown) => void)("wechat_meta", {
      requestId,
    });

    // 触发 AI
    (pi.sendUserMessage as (content: string, opts?: unknown) => Promise<void>)(formatted, {
      deliverAs: "followUp",
    });
  }

  /**
   * 格式化微信消息
   * 格式: {prefix} {content}
   */
  async formatMessage(msg: WeixinMessage, opts: { baseUrl: string; token: string }): Promise<string> {
    const prefix = getPrefix();
    const parts: string[] = [];

    for (const item of msg.item_list ?? []) {
      switch (item.type) {
        case 1: // TEXT
          parts.push(item.text_item?.text ?? "");
          break;
        case 2: // IMAGE
          const imagePath = await this.downloadImage(item.image_item!, opts.baseUrl, opts.token);
          parts.push(imagePath ? `[image:${imagePath}]` : "[📷 图片下载失败]");
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

    return `${prefix} ${parts.join("\n")}`;
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
      await this.sendReplyToUser("可用命令: /help");
    }
  }

  /**
   * AI 处理完成
   */
  onAiDone(): void {
    this.isAiProcessing = false;
    this.currentRequestId = null;

    // 处理队列中的下一条
    if (this.pendingMessages.length > 0) {
      this.safelyTriggerNext();
    }
  }

  /**
   * 安全地触发下一条消息
   */
  private safelyTriggerNext(retryCount = 0): void {
    const MAX_RETRY = 3;
    const BASE_DELAY = 20;

    setTimeout(() => {
      if (this.pendingMessages.length === 0) {
        this.isAiProcessing = false;
        return;
      }

      try {
        const { msg, requestId } = this.pendingMessages.shift()!;
        console.log(`[Wechat] Triggering next message (retry: ${retryCount})`);
        const opts = this.getCurrentOpts();
        if (opts) {
          this.triggerAiInternal(msg, requestId, opts);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("already processing") && retryCount < MAX_RETRY) {
          console.warn(`[Wechat] Agent still busy, retry ${retryCount + 1}/${MAX_RETRY}`);
          this.safelyTriggerNext(retryCount + 1);
        } else {
          console.error(`[Wechat] Failed to process queued message: ${errMsg}`);
          this.isAiProcessing = false;
          this.safelyTriggerNext();
        }
      }
    }, BASE_DELAY * Math.pow(1.5, retryCount));
  }

  private getCurrentOpts(): { baseUrl: string; token: string } | null {
    return wechatConfig ? { baseUrl: wechatConfig.baseUrl, token: wechatConfig.token } : null;
  }

  // ============== Typing 相关（单用户）==============

  /**
   * 获取 typing_ticket（单用户）
   */
  async getTypingTicket(): Promise<string | null> {
    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      return null;
    }

    // 检查缓存
    if (this.typingTicketCache && Date.now() < this.typingTicketCache.expiresAt) {
      return this.typingTicketCache.ticket;
    }

    try {
      const configResp = await getConfig({
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        ilinkUserId: this.singleUserId,
        contextToken: this.singleContextToken,
      });

      if (configResp.ret === 0 && configResp.typing_ticket) {
        this.typingTicketCache = {
          ticket: configResp.typing_ticket,
          expiresAt: Date.now() + this.TYPING_TICKET_CACHE_TTL_MS,
        };
        return configResp.typing_ticket;
      }
    } catch (err) {
      console.error(`[Wechat] getTypingTicket failed:`, err);
    }

    return null;
  }

  /**
   * 发送 typing 状态（单用户）
   */
  async sendTypingStatus(status: 1 | 2): Promise<void> {
    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      return;
    }

    const ticket = await this.getTypingTicket();
    if (!ticket) {
      console.error(`[Wechat] sendTypingStatus: failed to get typing_ticket`);
      return;
    }

    try {
      await sendTyping({
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        body: {
          ilink_user_id: this.singleUserId,
          typing_ticket: ticket,
          status,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Wechat] sendTypingStatus failed:`, errMsg);
      if (errMsg.includes("ticket")) {
        this.typingTicketCache = null;
      }
    }
  }

  /**
   * 开始 typing keepalive（单用户）
   */
  async startTypingKeepalive(): Promise<void> {
    await this.stopTypingKeepalive();

    console.log(`[Wechat] startTypingKeepalive: interval=${this.TYPING_KEEPALIVE_INTERVAL_MS}ms`);
    await this.sendTypingStatus(1);

    const timer = setInterval(async () => {
      await this.sendTypingStatus(1);
    }, this.TYPING_KEEPALIVE_INTERVAL_MS);

    this.typingKeepaliveTimer = timer;
  }

  /**
   * 停止 typing keepalive（单用户）
   */
  async stopTypingKeepalive(): Promise<void> {
    if (this.typingKeepaliveTimer) {
      clearInterval(this.typingKeepaliveTimer);
      this.typingKeepaliveTimer = null;
    }
  }

  // ============== 发送消息（单用户）==============

  /**
   * 发送回复给单用户
   */
  async sendReplyToUser(text: string): Promise<void> {
    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      throw new Error("Single user not initialized");
    }

    const msg: WeixinMessage = {
      from_user_id: "",
      to_user_id: this.singleUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: this.singleContextToken,
      item_list: [{ type: 1, text_item: { text } }],
    };

    await sendMessage({
      baseUrl: wechatConfig.baseUrl,
      token: wechatConfig.token,
      body: { msg },
    });
  }

  /**
   * 发送消息到微信（带重试）
   */
  async sendMessageWithRetry(text: string, maxRetries: number = 3): Promise<void> {
    if (!this.singleUserId || !this.singleContextToken) {
      throw new Error("Single user not initialized");
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendReplyToUser(text);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errMsg = lastError.message;
        console.error(`[Wechat] sendMessage attempt ${attempt} failed:`, errMsg);
        if (attempt < maxRetries) {
          await this.sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
    }

    throw lastError ?? new Error("sendMessage failed");
  }

  // ============== 防重相关 ==============

  getCurrentRequestId(): string | null {
    return this.currentRequestId;
  }

  isRequestProcessed(requestId: string): boolean {
    return this.processedRequests.has(requestId);
  }

  markRequestProcessed(requestId: string): void {
    this.processedRequests.set(requestId, Date.now());
    this.cleanupCounter++;

    if (this.cleanupCounter >= 50) {
      this.cleanupProcessedRequests();
    }
  }

  cleanupProcessedRequests(): void {
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, timestamp] of this.processedRequests) {
      if (timestamp < oneHourAgo) {
        this.processedRequests.delete(id);
      }
    }
    this.cleanupCounter = 0;
  }

  // ============== 重置 ==============

  reset(): void {
    this.stopTypingKeepalive();
    this.typingTicketCache = null;

    this.pendingMessages = [];
    this.processedRequests.clear();
    this.currentRequestId = null;
    this.isAiProcessing = false;
    this.cleanupCounter = 0;
    this.abortController = new AbortController();
    
    console.log("[Wechat] Engine state reset");
  }

  // ============== 图片下载 ==============

  private parseAesKey(aesKeyInput: string): Buffer | null {
    if (!aesKeyInput) return null;
    const trimmed = aesKeyInput.trim();

    if (trimmed.length === 32 && /^[0-9a-fA-F]{32}$/.test(trimmed)) {
      return Buffer.from(trimmed, "hex");
    }

    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 16) return decoded;
      if (decoded.length === 24) {
        const hexStr = decoded.toString("utf8").trim();
        if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
          return Buffer.from(hexStr, "hex");
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  async downloadImage(img: ImageItem, baseUrl: string, token: string): Promise<string | null> {
    try {
      const target = img.thumb_media || img.media;
      const fullUrl = target?.full_url;
      const aesKeyRaw = img.aeskey || img.media?.aes_key;

      if (!fullUrl || !aesKeyRaw) return null;

      const aesKey = this.parseAesKey(aesKeyRaw);
      if (!aesKey) return null;

      const res = await fetch(fullUrl);
      if (!res.ok) return null;

      const encrypted = Buffer.from(await res.arrayBuffer());
      const decrypted = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
      const final = Buffer.concat([decrypted.update(encrypted), decrypted.final()]);

      return saveImageToStorage(final, ".jpg");
    } catch (err) {
      console.error(`[Wechat] Image download failed:`, err);
      return null;
    }
  }

  // ============== 工具方法 ==============

  /**
   * 生成请求 ID（精确到毫秒）
   * 格式: YYYYMMDDHHMMSSmmm (17位)
   */
  private generateRequestId(): string {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${yy}${mm}${dd}${hh}${min}${ss}${ms}`;
  }

  private isSessionExpiredError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      return err.errcode === -14 || err.code === -14;
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// === 导出单例 ===
export const engine = new WechatEngine();
