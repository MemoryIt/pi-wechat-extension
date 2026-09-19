/**
 * wechat.ts - 微信核心引擎（单用户版本）
 * 
 * 主要变化:
 * 1. 删除多用户相关逻辑 (userContexts Map, pendingMessages Map 等)
 * 2. requestId 改为精确到毫秒的时间戳格式
 * 3. 消息格式化简化为: {prefix} {content}
 * 4. 单用户固定凭证，运行时从 storage 加载
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WeixinMessage } from "../api/types";
import { MessageItemType } from "../api/types.js";
import * as storage from "./storage/state.js";
import { isDebugEnabled } from "./config.js";
import { MediaStore } from "./media-store.js";
import { formatTimestamp } from "./time.js";
import { PollingLoop } from "./polling.js";
import type { ConnectionState } from "./polling.js";
import { TurnQueue, SerialTaskQueue } from "./queue.js";
import { TypingController } from "./typing.js";
import type { TypingCredentials } from "./typing.js";
import { MessageSender } from "./sender.js";
import { createLogger } from "./logger.js";

// 保持对外导出兼容（ConnectionState 现已迁至 polling.ts）
export type { ConnectionState } from "./polling.js";

// ============== 宿主依赖（依赖注入）==============

/**
 * 窄接口：WechatEngine 只依赖 pi 的这三个方法，
 * 避免测试必须实现整个 ExtensionAPI。
 */
export interface WechatHost {
  appendEntry(customType: string, data?: unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export interface WechatConfig {
  baseUrl: string;
  token: string;
}

/**
 * 门面：把完整 ExtensionAPI 适配为窄接口 WechatHost 后注入单例 engine。
 * index.ts 依赖此函数，保持签名不变。
 */
export function setPi(piInstance: ExtensionAPI): void {
  engine.setHost({
    appendEntry: (t, d) => piInstance.appendEntry(t, d),
    sendUserMessage: (c, o) => piInstance.sendUserMessage(c, o),
    sendMessage: (m, o) => piInstance.sendMessage(m, o),
  });
}

export function setConfig(config: WechatConfig): void {
  engine.setConfig(config);
}

// ============== WechatEngine（单用户版本）==============

export class WechatEngine {
  // === 统一控制台日志（脱敏；isDebugEnabled 每次调用求值）===
  private logger = createLogger({ isDebugEnabled: () => isDebugEnabled() });

  // === 轮询会话（职责已抽到独立 PollingLoop，通过 deps 回调宿主能力）===
  private poller: PollingLoop;

  private accountId: string | null = null;

  // === 单用户凭证（运行时加载）===
  private singleUserId: string | null = null;
  private singleContextToken: string | null = null;

  // === 请求追踪（仅 requestId）===
  private lastRequestIdMs = -1;
  private requestIdSeq = 0;

  // === 终端消息处理状态（仍留 engine）===
  private isTerminalMessageProcessing = false;

  // === 消息队列 / 忙闲 / 去重（抽到 TurnQueue）===
  private queue = new TurnQueue<{ msg: WeixinMessage; requestId: string }>();

  // === 媒体存储 / 后台串行队列（B5：媒体下载不阻塞轮询）===
  private mediaStore = new MediaStore({
    log: (...a: unknown[]) => this.logger.debug(String(a[0] ?? ""), ...a.slice(1)),
    errLog: (...a: unknown[]) => this.logger.error(String(a[0] ?? ""), ...a.slice(1)),
  });
  private mediaQueue = new SerialTaskQueue((err) =>
    this.logger.error("Media background task failed", err),
  );

  // === Typing / 发送 协作类（单用户）===
  private typing = new TypingController({
    getCredentials: () => this.getCredentials(),
    debug: this.logger.debug.bind(this.logger),
    error: this.logger.error.bind(this.logger),
  });
  private sender = new MessageSender({
    getCredentials: () => this.getCredentials(),
    debug: this.logger.debug.bind(this.logger),
    error: this.logger.error.bind(this.logger),
  });

  // === 注入依赖（host / config）===
  private host: WechatHost | null = null;
  private config: WechatConfig | null = null;

  // === 通知回调（B4：会话过期时提示用户）===
  private notifier: ((message: string, type?: "info" | "warning" | "error") => void) | null = null;

  constructor() {
    this.poller = new PollingLoop({
      ensureSession: () => this.initSingleUser(),
      getAccountId: () => this.accountId,
      loadCursor: (accountId) => storage.loadSyncCursor(accountId),
      saveCursor: (accountId, cursor) => storage.saveSyncCursor(accountId, cursor),
      onMessage: (msg, opts) => this.handleMessage(msg, opts),
      onNeedsRelogin: () => {
        this.logger.debug("Session expired, needs relogin");
        this.notifier?.("微信登录已失效，请执行 /wechat login 重新登录", "error");
      },
      debug: this.logger.debug.bind(this.logger),
      error: this.logger.error.bind(this.logger),
      sleep: (ms) => this.sleep(ms),
    });
  }

  setHost(host: WechatHost): void {
    this.host = host;
  }

  setNotifier(notifier: (message: string, type?: "info" | "warning" | "error") => void): void {
    this.notifier = notifier;
  }

  setConfig(config: WechatConfig): void {
    this.config = config;
  }

  /** 可选字段各自覆盖：未提供的依赖保持不变。 */
  configure(deps: { host?: WechatHost; config?: WechatConfig }): void {
    if (deps.host) this.host = deps.host;
    if (deps.config) this.config = deps.config;
  }

  // === getter ===
  get connectionState(): ConnectionState {
    return this.poller.connectionState;
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
      this.logger.error("No logged in account found");
      return false;
    }

    this.singleUserId = credentials.userId;
    this.accountId = credentials.accountId;

    // 加载 context token
    this.singleContextToken = await storage.getSingleUserContextToken();
    if (!this.singleContextToken) {
      this.logger.warn("No context token found, replies may fail");
    }

    this.logger.debug(`Single user initialized: userId=${this.singleUserId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);
    return true;
  }

  /**
   * 停止长轮询（委托 PollingLoop）
   */
  stopPolling(): void {
    this.poller.stop();
  }

  /**
   * 启动长轮询（委托 PollingLoop）
   */
  async startPolling(opts: { baseUrl: string; token: string }): Promise<void> {
    await this.poller.start(opts);
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
      this.logger.debug(`Updating contextToken from message`);
      this.singleContextToken = msg.context_token;
      // contextToken 变化后旧 typing ticket 立即失效
      this.typing.invalidateTicket();
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
    if (this.queue.isBusy() || this.isTerminalMessageProcessing) {
      // 加入队列
      this.queue.enqueue({ msg, requestId });
      this.logger.debug(`AI is ${this.queue.isBusy() ? 'processing' : 'terminal processing'}, queued message (queue size: ${this.queue.size})`);
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
      this.logger.debug(`Media message detected, acknowledging and processing in background...`);

      // B5：立即 ack（不含路径），下载/落盘放到后台串行队列，不阻塞轮询主循环。
      await this.sendTextMessage("媒体文件已收到，正在保存…");

      this.mediaQueue.enqueue(() => this.processMediaInBackground(msg, requestId, opts));

      // 标记处理完成并退出
      this.markRequestProcessed(requestId);

      // 处理队列中的下一条
      if (this.queue.size > 0) {
        this.safelyTriggerNext();
      }
      return;
    }

    // === 文本消息处理 ===
    this.queue.setCurrentRequestId(requestId);
    this.queue.setBusy(true);
    let handedOffToAgent = false;

    try {
      const host = this.host;
      if (!host) throw new Error("WechatHost not configured");

      this.logger.debug(`triggerAi: requestId=${requestId}, contextToken=${this.singleContextToken ? 'present' : 'MISSING'}`);

      // 写入 wechat_meta（仅 requestId）—— pi 调用可能同步抛错
      host.appendEntry("wechat_meta", { requestId });

      // 直接获取文本内容
      const textParts: string[] = [];
      for (const item of msg.item_list ?? []) {
        if (item.type === MessageItemType.TEXT) {
          textParts.push(item.text_item?.text ?? "");
        }
      }
      const content = textParts.join("\n");

      // sendUserMessage 为同步 void：同步抛错必须在这里被捕获，不得冒泡成「轮询失败」
      host.sendUserMessage(content, { deliverAs: "followUp" });
      handedOffToAgent = true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`triggerAiInternal failed (requestId=${requestId}):`, errMsg);
      this.markRequestProcessed(requestId);
    } finally {
      // 错误路径：无论从哪个 await 抛出都必须释放处理锁并继续排空队列。
      // 成功路径保持 isAiProcessing=true，等待 onAiDone() 通知本轮结束。
      if (!handedOffToAgent) {
        this.queue.setBusy(false);
        this.queue.setCurrentRequestId(null);
        if (this.queue.size > 0) {
          void this.safelyTriggerNext();
        }
      }
    }
  }

  /**
   * B5：后台串行处理媒体下载/落盘，完成后写入会话历史（含保存路径）。
   * 外层 try/catch 保证不向调用方抛出。
   */
  private async processMediaInBackground(
    msg: WeixinMessage,
    requestId: string,
    opts: { baseUrl: string; token: string },
  ): Promise<void> {
    try {
      const paths = await this.mediaStore.downloadAll(msg.item_list ?? [], opts.baseUrl);

      if (paths.length > 0) {
        const host = this.host;
        if (!host) throw new Error("WechatHost not configured");

        host.sendMessage(
          { customType: "wechat_media", content: `媒体文件已保存到 ${paths[0]}`, display: false },
          { triggerTurn: false, deliverAs: "followUp" },
        );
      }
    } catch (err) {
      this.logger.error(`processMediaInBackground failed (requestId=${requestId}):`, err);
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
    this.queue.setBusy(false);
    this.queue.setCurrentRequestId(null);

    // 处理队列中的下一条
    if (this.queue.size > 0) {
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

    if (this.queue.size === 0) {
      this.queue.setBusy(false);
      return;
    }

    const { msg, requestId } = this.queue.dequeue()!;
    this.logger.debug(`Triggering next message (queue size: ${this.queue.size})`);

    const opts = this.getCurrentOpts();
    if (!opts) {
      this.logger.error("Failed to process queued message: engine config missing");
      this.queue.setBusy(false);
      if (this.queue.size > 0) void this.safelyTriggerNext();
      return;
    }

    try {
      await this.triggerAiInternal(msg, requestId, opts);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to process queued message: ${errMsg}`);
      this.queue.setBusy(false);
      this.queue.setCurrentRequestId(null);
      if (this.queue.size > 0) void this.safelyTriggerNext();
    }
  }

  private getCurrentOpts(): { baseUrl: string; token: string } | null {
    const cfg = this.config;
    return cfg ? { baseUrl: cfg.baseUrl, token: cfg.token } : null;
  }

  // ============== Typing 相关（单用户）==============

  /**
   * 组装当前单用户凭证；任一缺失返回 null。
   */
  private getCredentials(): TypingCredentials | null {
    const config = this.config;
    if (!config || !this.singleUserId || !this.singleContextToken) {
      return null;
    }
    return {
      baseUrl: config.baseUrl,
      token: config.token,
      userId: this.singleUserId,
      contextToken: this.singleContextToken,
    };
  }

  /**
   * 获取 typing_ticket（单用户）
   */
  async getTypingTicket(): Promise<string | null> {
    return this.typing.getTicket();
  }

  /**
   * 发送 typing 状态（单用户）
   */
  async sendTypingStatus(status: 1 | 2): Promise<void> {
    return this.typing.sendStatus(status);
  }

  /**
   * 开始 typing keepalive（单用户）
   */
  async startTypingKeepalive(): Promise<void> {
    return this.typing.startKeepalive();
  }

  /**
   * 停止 typing keepalive（单用户）
   */
  async stopTypingKeepalive(): Promise<void> {
    return this.typing.stopKeepalive();
  }

  // ============== 发送消息（单用户）==============

  /**
   * 使用官方文本发送接口发送纯文字消息（推荐！）
   * 完全取代 sendMessageToUser + sendReplyToUser
   */
  async sendTextMessage(text: string): Promise<void> {
    return this.sender.sendText(text);
  }

  /**
   * 向微信发送本地文件 —— 直接使用官方媒体发送接口（自动路由图片/视频/文件）
   */
  async sendFileToUser(localPath: string): Promise<void> {
    return this.sender.sendFile(localPath);
  }

  /**
   * 发送消息到微信（带重试）
   */
  async sendMessageWithRetry(text: string, maxRetries: number = 3): Promise<void> {
    return this.sender.sendWithRetry(text, maxRetries);
  }

  // ============== 防重相关 ==============

  getCurrentRequestId(): string | null {
    return this.queue.getCurrentRequestId();
  }

  isRequestProcessed(requestId: string): boolean {
    return this.queue.isRequestProcessed(requestId);
  }

  markRequestProcessed(requestId: string): void {
    this.queue.markRequestProcessed(requestId);
  }

  cleanupProcessedRequests(): void {
    this.queue.cleanupProcessedRequests();
  }

  // ============== 重置 ==============

  reset(): void {
    this.typing.reset();

    this.queue.reset();
    this.isTerminalMessageProcessing = false;
    this.lastRequestIdMs = -1;
    this.requestIdSeq = 0;

    // 轮询部分：generation 过期、abort、重建 controller、清 cursor/连接状态/失败计数
    this.poller.reset();

    // 清空账号相关状态
    this.accountId = null;
    this.singleUserId = null;
    this.singleContextToken = null;

    this.logger.debug("Engine state reset");
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// === 工厂函数（供测试隔离：创建不共享模块单例状态的独立实例）===
export function createWechatEngine(initial?: { host?: WechatHost; config?: WechatConfig }): WechatEngine {
  const instance = new WechatEngine();
  if (initial) instance.configure(initial);
  return instance;
}

// === 导出单例 ===
export const engine = new WechatEngine();
