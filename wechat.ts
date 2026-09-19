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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/**
 * 轮询中止哨兵：用于区分「主动 stopPolling」与真实网络错误。
 * 底层 getUpdates 不接受 AbortSignal，核心层改用 Promise.race 抢跑中止。
 */
const POLL_ABORTED = Symbol("wechat-poll-aborted");

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
 * 统一时间戳工具：YYMMDDHHMMSSmmm (17位，本地时间)。
 * requestId 与媒体文件名共用，避免重复实现。
 */
function formatTimestamp(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
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

  const filename = `${formatTimestamp(new Date())}_${randomUUID().slice(0, 8)}.${ext}`;
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

  // === 轮询会话控制（重入守卫 + 过期结果丢弃）===
  private pollingActive = false;
  private pollingGeneration = 0;

  // === 单用户凭证（运行时加载）===
  private singleUserId: string | null = null;
  private singleContextToken: string | null = null;

  // === 请求追踪（仅 requestId）===
  private currentRequestId: string | null = null;
  private processedRequests = new Map<string, number>();
  private cleanupCounter = 0;
  private lastRequestIdMs = -1;
  private requestIdSeq = 0;

  // === AI 处理状态 ===
  private isAiProcessing = false;

  // === 终端消息处理状态（新增）===
  private isTerminalMessageProcessing = false;

  // === 消息队列（单用户，不需要 Map）===
  private pendingMessages: Array<{ msg: WeixinMessage; requestId: string }> = [];

  // === Typing 相关（单用户）===
  private typingTicketCache: { ticket: string; expiresAt: number; contextToken: string } | null = null;
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
   *
   * 记录停止动作（abort），使 startPolling 内的 Promise.race 立即抢跑退出。
   * 注意：底层 getUpdates 不接受 AbortSignal，因此在途请求仍会在后台直到超时
   * （35s）才结束；但核心层不再等待它，轮询循环会迅速退出。
   */
  stopPolling(): void {
    this.abortController.abort();
    this.state.connectionState = "disconnected";
  }

  /**
   * 构造「收到 abort 即 reject(POLL_ABORTED)」的 promise，并返回解除监听的函数。
   */
  private createAbortWaiter(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
    let onAbort: (() => void) | null = null;
    const promise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(POLL_ABORTED);
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return {
      promise,
      dispose: () => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  /**
   * 启动长轮询
   *
   * 重入守卫：若已有轮询会话在运行，直接返回，绝不并发第二条循环。
   * generation 令牌：reset()/新会话会让旧令牌过期，旧循环拿到过期结果后直接丢弃，
   * 避免污染新会话状态。
   */
  async startPolling(opts: { baseUrl: string; token: string }): Promise<void> {
    if (this.pollingActive) {
      debugLog("startPolling ignored: polling is already active");
      return;
    }
    this.pollingActive = true;
    const generation = ++this.pollingGeneration;

    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    const abortSignal = this.abortController.signal;

    try {
      // 初始化单用户凭证
      if (!(await this.initSingleUser())) {
        return;
      }
      if (generation !== this.pollingGeneration) return;

      // 加载 sync cursor
      this.state.syncCursor = (await storage.loadSyncCursor(this.accountId!)) ?? "";

      while (!abortSignal.aborted) {
        if (generation !== this.pollingGeneration) break;

        // 在途请求与 abort 抢跑：stopPolling 后循环迅速退出。
        // 在途 getUpdates 仍在后台直到自身超时（底层不支持 AbortSignal）。
        const abortWaiter = this.createAbortWaiter(abortSignal);
        try {
          const updates = await Promise.race([
            getUpdates({
              get_updates_buf: this.state.syncCursor,
              baseUrl: opts.baseUrl,
              token: opts.token,
              timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
            }),
            abortWaiter.promise,
          ]);

          if (generation !== this.pollingGeneration) break;

          for (const msg of updates.msgs ?? []) {
            if (abortSignal.aborted || generation !== this.pollingGeneration) break;
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
          // 主动停止 / 过期会话：直接退出，不当作轮询失败
          if (error === POLL_ABORTED || abortSignal.aborted || generation !== this.pollingGeneration) {
            debugLog("Polling loop aborted, exiting");
            break;
          }

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
        } finally {
          abortWaiter.dispose();
        }
      }
    } finally {
      // 只有当前会话仍是最新时才释放守卫，避免旧循环误清新会话
      if (generation === this.pollingGeneration) {
        this.pollingActive = false;
        this.state.connectionState = "disconnected";
      }
    }
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
      // contextToken 变化后旧 typing ticket 立即失效
      this.typingTicketCache = null;
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
        pi.sendMessage(
          { customType: "wechat_media", content: replyText, display: false },
          { triggerTurn: false, deliverAs: "followUp" },
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
    let handedOffToAgent = false;

    try {
      debugLog(`triggerAi: requestId=${requestId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);

      // 写入 wechat_meta（仅 requestId）—— pi 调用可能同步抛错
      pi.appendEntry("wechat_meta", { requestId });

      // 直接获取文本内容
      const textParts: string[] = [];
      for (const item of msg.item_list ?? []) {
        if (item.type === MessageItemType.TEXT) {
          textParts.push(item.text_item?.text ?? "");
        }
      }
      const content = textParts.join("\n");

      // sendUserMessage 为同步 void：同步抛错必须在这里被捕获，不得冒泡成「轮询失败」
      pi.sendUserMessage(content, { deliverAs: "followUp" });
      handedOffToAgent = true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Wechat] triggerAiInternal failed (requestId=${requestId}):`, errMsg);
      this.markRequestProcessed(requestId);
    } finally {
      // 错误路径：无论从哪个 await 抛出都必须释放处理锁并继续排空队列。
      // 成功路径保持 isAiProcessing=true，等待 onAiDone() 通知本轮结束。
      if (!handedOffToAgent) {
        this.isAiProcessing = false;
        this.currentRequestId = null;
        if (this.pendingMessages.length > 0) {
          void this.safelyTriggerNext();
        }
      }
    }
  }

  /**
   * 提取消息中所有文本项拼接后的内容
   */
  private extractText(msg: WeixinMessage): string {
    const parts: string[] = [];
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT) {
        parts.push(item.text_item?.text ?? "");
      }
    }
    return parts.join("\n");
  }

  /**
   * 检查是否是 slash command（遍历所有 item，不再只看首条 / 不再用魔法数字）
   */
  private isSlashCommand(msg: WeixinMessage): boolean {
    for (const item of msg.item_list ?? []) {
      if (item.type !== MessageItemType.TEXT) continue;
      const text = item.text_item?.text ?? "";
      if (text.trim().startsWith("/")) return true;
    }
    return false;
  }

  /**
   * 处理 slash command
   */
  private async handleSlashCommand(msg: WeixinMessage, opts: { baseUrl: string; token: string }): Promise<void> {
    const trimmed = this.extractText(msg).trim();

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
   *
   * 必须 await 并 catch triggerAiInternal，否则排空时的 rejection 会变成未处理
   * 拒绝并卡死 isAiProcessing。移除了基于错误字符串匹配的重试，避免无限递归。
   */
  private async safelyTriggerNext(): Promise<void> {
    const BASE_DELAY = 20;
    await this.sleep(BASE_DELAY);

    if (this.pendingMessages.length === 0) {
      this.isAiProcessing = false;
      return;
    }

    const { msg, requestId } = this.pendingMessages.shift()!;
    debugLog(`Triggering next message (queue size: ${this.pendingMessages.length})`);

    const opts = this.getCurrentOpts();
    if (!opts) {
      console.error("[Wechat] Failed to process queued message: engine config missing");
      this.isAiProcessing = false;
      if (this.pendingMessages.length > 0) void this.safelyTriggerNext();
      return;
    }

    try {
      await this.triggerAiInternal(msg, requestId, opts);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Wechat] Failed to process queued message: ${errMsg}`);
      this.isAiProcessing = false;
      this.currentRequestId = null;
      if (this.pendingMessages.length > 0) void this.safelyTriggerNext();
    }
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

    // 检查缓存：必须与当前 contextToken 匹配，token 变化后旧 ticket 失效
    if (
      this.typingTicketCache &&
      this.typingTicketCache.contextToken === this.singleContextToken &&
      Date.now() < this.typingTicketCache.expiresAt
    ) {
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
          contextToken: this.singleContextToken,
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

    // 不要让 keepalive timer 阻止进程退出
    timer.unref?.();

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
  async sendFileToUser(localPath: string): Promise<void> {
    // 底层 sendWeixinMediaFile 不支持自定义显示名，显示名以本地文件 basename 为准，
    // 因此不再接收/透传 fileName。
    if (!localPath || typeof localPath !== "string") {
      throw new Error("sendFileToUser: localPath 不能为空");
    }

    if (!wechatConfig || !this.singleUserId || !this.singleContextToken) {
      throw new Error("Single user not initialized");
    }

    const displayName = path.basename(localPath);
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
    this.isTerminalMessageProcessing = false;
    this.consecutiveFailures = 0;
    this.cleanupCounter = 0;
    this.lastRequestIdMs = -1;
    this.requestIdSeq = 0;

    // 让旧轮询会话的 generation 过期，丢弃其后续结果
    this.pollingGeneration++;
    this.pollingActive = false;

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
   * 生成请求 ID
   * 格式: YYMMDDHHMMSSmmm + 3 位同毫秒序号（保证同一毫秒内也唯一）
   */
  private generateRequestId(): string {
    const now = Date.now();
    if (now !== this.lastRequestIdMs) {
      this.lastRequestIdMs = now;
      this.requestIdSeq = 0;
    } else {
      this.requestIdSeq += 1;
    }
    return `${formatTimestamp(new Date(now))}${String(this.requestIdSeq).padStart(3, "0")}`;
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
