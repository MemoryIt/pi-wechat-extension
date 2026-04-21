/**
 * wechat.ts - 微信核心引擎（单用户版本）
 * 
 * 主要变化:
 * 1. 删除多用户相关逻辑 (userContexts Map, pendingMessages Map 等)
 * 2. requestId 改为精确到毫秒的时间戳格式
 * 3. 消息格式化简化为: {prefix} {content}
 * 4. 单用户固定凭证，运行时从 storage 加载
 */

import path from "node:path";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { sendMessageWeixin } from "./messaging/send.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WeixinMessage } from "./api/types";
import { MessageItemType } from "./api/types.js";
import * as storage from "./storage/state.js";
import { getUpdates, sendTyping, getConfig } from "./api/api.js";
import type { WeixinApiOptions } from "./api/api.js";
// ============== 类型定义 ==============

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "needs_relogin";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getMediaStoragePath, isDebugEnabled } from "./config.js";
import { downloadMediaFromItem } from "./media/media-download.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

// ============== 调试日志辅助函数 ==============

function debugLog(message: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(`[Wechat] ${message}`, ...args);
  }
}

// ============== 媒体存储配置 ==============

/**
 * 获取 ISO 周数
 */
function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * 获取当前 ISO 周文件夹名称，格式: {year}{week} (如 "2605")
 */
function getCurrentWeekFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const week = getISOWeek(now);
  return `${String(year).slice(-2)}${String(week).padStart(2, '0')}`;
}

/**
 * 生成文件时间戳格式: YYYYMMDDHHMMSSmmm (17位)
 */
function generateFileTimestamp(): string {
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

/**
 * 保存媒体文件到存储
 * 路径: {mediaStoragePath}/{year}{week}/{timestamp}_{uuid8}.{ext}
 */
function saveMediaToStorage(buffer: Buffer, ext: string): string {
  const basePath = getMediaStoragePath();
  const weekFolder = getCurrentWeekFolder();
  const targetDir = join(basePath, weekFolder);

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const filename = `${generateFileTimestamp()}_${randomUUID().slice(0, 8)}.${ext}`;
  const filepath = join(targetDir, filename);
  writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * MIME 类型到扩展名的映射
 */
const CONTENT_TYPE_EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "audio/wav": "wav",
  "audio/silk": "silk",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/**
 * 根据文件头魔数（Magic Bytes）检测文件类型
 */
function detectFileType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return "jpg";
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return "png";
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return "gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length >= 8 && buffer[4] === 0x57 && buffer[5] === 0x45 && buffer[6] === 0x42 && buffer[7] === 0x50) {
      return "webp";
    }
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return "bmp";
  }
  // MP4/QuickTime: 66 74 79 70 (ftyp)
  if (buffer[0] === 0x66 && buffer[1] === 0x74 && buffer[2] === 0x79 && buffer[3] === 0x70) {
    return "mp4";
  }
  // SILK: 02 开头
  if (buffer[0] === 0x02) {
    return "silk";
  }
  // OGG: 4F 67 67 53 (OggS)
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return "ogg";
  }

  return null;
}

/**
 * SaveMediaFn 回调实现（用于 downloadMediaFromItem）
 */
type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

function createSaveMediaCallback(): SaveMediaFn {
  return async (buffer, contentType, _subdir, _maxBytes, originalFilename) => {
    let ext: string;
    if (originalFilename) {
      ext = originalFilename.split('.').pop() ?? 'bin';
    } else if (contentType) {
      ext = CONTENT_TYPE_EXT_MAP[contentType] ?? 'bin';
    } else {
      // 尝试通过魔数检测
      ext = detectFileType(buffer) ?? 'bin';
    }
    const path = saveMediaToStorage(buffer, ext);
    return { path };
  };
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

  // === 终端消息处理状态（新增）===
  private isTerminalMessageProcessing = false;

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

  // === 终端处理状态 getter/setter（新增）===
  getTerminalProcessing(): boolean {
    return this.isTerminalMessageProcessing;
  }

  setTerminalProcessing(value: boolean): void {
    this.isTerminalMessageProcessing = value;
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

    debugLog(`Single user initialized: userId=${this.singleUserId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);
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
      debugLog(`Updating contextToken from message`);
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

    // 触发 AI 处理
    await this.triggerAi(msg, requestId, opts);
  }

  /**
   * 触发 AI 处理消息
   * 单用户模式，无需 userId 参数
   */
  async triggerAi(msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    // 只有当 AI 空闲且没有终端消息在处理时，才直接发送
    // 否则加入队列等待
    if (this.isAiProcessing || this.isTerminalMessageProcessing) {
      // 加入队列
      this.pendingMessages.push({ msg, requestId });
      debugLog(`AI is ${this.isAiProcessing ? 'processing' : 'terminal processing'}, queued message (queue size: ${this.pendingMessages.length})`);
      return;
    }

    await this.triggerAiInternal(msg, requestId, opts);
  }

  /**
   * 内部方法：触发 AI 处理
   */
  private async triggerAiInternal(msg: WeixinMessage, requestId: string, opts: { baseUrl: string; token: string }): Promise<void> {
    // === 媒体消息处理 ===
    const hasText = msg.item_list?.some(item => item.type === MessageItemType.TEXT && item.text_item?.text?.trim());
    const hasMedia = msg.item_list?.some(item => item.type !== MessageItemType.TEXT);

    if (hasMedia && !hasText) {
      debugLog(`Media message detected, downloading...`);

      const saveMedia = createSaveMediaCallback();
      const mediaPaths: string[] = [];

      for (const item of msg.item_list ?? []) {
        if (item.type === MessageItemType.TEXT) continue;

        try {
          const result = await downloadMediaFromItem(item, {
            cdnBaseUrl: opts.baseUrl,
            saveMedia,
            log: debugLog,
            errLog: console.error,
            label: `media-${item.type}`,
          });

          const savedPath =
            result.decryptedPicPath ??
            result.decryptedVoicePath ??
            result.decryptedFilePath ??
            result.decryptedVideoPath;

          if (savedPath) {
            mediaPaths.push(savedPath);
            debugLog(`Media saved: ${savedPath}`);
          }
        } catch (err) {
          console.error(`[Wechat] Media download failed for type ${item.type}:`, err);
        }
      }

      // 回复用户并加入历史
      if (mediaPaths.length > 0) {
        const replyText = `媒体文件已收到，成功保存到 ${mediaPaths[0]}`;
        await this.sendTextMessage(replyText);

        // 加入会话历史（不触发 AI 回复）
        (pi.sendMessage as (msg: unknown, opts?: unknown) => Promise<void>)(
          { content: replyText },
          { triggerTurn: false, deliverAs: "followUp" }
        );
      }

      // 标记处理完成并退出
      this.isAiProcessing = false;
      this.markRequestProcessed(requestId);

      // 处理队列中的下一条
      if (this.pendingMessages.length > 0) {
        this.safelyTriggerNext();
      }
      return;
    }

    // === 文本消息处理 ===
    this.currentRequestId = requestId;
    this.isAiProcessing = true;

    debugLog(`triggerAi: requestId=${requestId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);

    // 写入 wechat_meta（仅 requestId）
    (pi.appendEntry as (type: string, data: unknown) => void)("wechat_meta", {
      requestId,
    });

    // 直接获取文本内容
    const textParts: string[] = [];
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT) {
        textParts.push(item.text_item?.text ?? "");
      }
    }
    const content = textParts.join("\n");

    (pi.sendUserMessage as (content: string, opts?: unknown) => Promise<void>)(content, {
      deliverAs: "followUp",
    });
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
      await this.sendTextMessage("可用命令: /help");
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
        debugLog(`Triggering next message (retry: ${retryCount})`);
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

    debugLog(`startTypingKeepalive: interval=${this.TYPING_KEEPALIVE_INTERVAL_MS}ms`);
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
   * 使用官方 sendMessageWeixin 发送纯文字消息（推荐！）
   * 完全取代 sendMessageToUser + sendReplyToUser
   */
  async sendTextMessage(text: string): Promise<void> {
    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      throw new Error("Single user not initialized");
    }
    debugLog(`sendTextMessage: text length=${text.length}`);

    await sendMessageWeixin({
      to: this.singleUserId,
      text: text,
      opts: {
        baseUrl: wechatConfig.baseUrl,
        token: wechatConfig.token,
        contextToken: this.singleContextToken,
      },
    });
    debugLog(`sendTextMessage: 文字消息发送成功`);
  }

  /**
   * 向微信发送本地文件 —— 直接使用官方 sendWeixinMediaFile（自动路由图片/视频/文件）
   */
  async sendFileToUser(localPath: string, fileName?: string): Promise<void> {
    // 当前实现已完美复用官方模块，保持不变
    if (!localPath || typeof localPath !== "string") {
      throw new Error("sendFileToUser: localPath 不能为空");
    }

    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      throw new Error("Single user not initialized");
    }

    const displayName = fileName || path.basename(localPath);
    debugLog(`sendFileToUser START: localPath=${localPath}, displayName=${displayName} (使用官方 sendWeixinMediaFile)`);

    const opts: WeixinApiOptions & { contextToken?: string } = {
      baseUrl: wechatConfig.baseUrl,
      token: wechatConfig.token,
      contextToken: this.singleContextToken!,
    };

    const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";

    // 直接调用官方高层函数（自动处理 upload + 正确构造 item）
    await sendWeixinMediaFile({
      filePath: localPath,
      to: this.singleUserId,
      text: "",
      opts,
      cdnBaseUrl,
    });

    debugLog(`sendFileToUser COMPLETE: 文件 "${displayName}" 已通过官方 sendWeixinMediaFile 发送成功`);
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
        await this.sendTextMessage(text);
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
    
    // 停止并重建 AbortController
    this.abortController.abort();
    this.abortController = new AbortController();
    
    // 清空账号相关状态
    this.accountId = null;
    this.singleUserId = null;
    this.singleContextToken = null;
    
    // 重置连接状态
    this.state.syncCursor = "";
    this.state.connectionState = "disconnected";
    
    debugLog("Engine state reset");
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
