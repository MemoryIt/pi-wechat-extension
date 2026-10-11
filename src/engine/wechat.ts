/**
 * wechat.ts - 微信引擎门面 / 组合根（单用户版本）
 *
 * 持有单用户凭证状态、TurnQueue、TypingController、MessageSender、
 * MessageRouter、PollingLoop，并把它们装配为完整引擎。
 * 对外提供 WechatHost 依赖注入、setPi / setConfig、单例 `engine`
 * 与 createWechatEngine() 工厂。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WeixinMessage, WechatCredentials } from "../ports/types.js";
import { MessageItemType } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatMedia } from "../ports/media.js";
import { createWechatInbound } from "../adapters/inbound.js";
import { createWechatOutbound } from "../adapters/outbound.js";
import { createWechatMedia } from "../adapters/media.js";
import * as storage from "../storage/state.js";
import { isDebugEnabled } from "../shared/config.js";
import { MediaStore } from "./media-store.js";
import { sleep, formatTimestamp } from "../shared/time.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import { ChannelState } from "../channel/state.js";
import type { Notifier } from "../channel/state.js";
import { PollingLoop } from "./polling.js";
import type { ConnectionState } from "./polling.js";
import { TurnQueue, SerialTaskQueue } from "./queue.js";
import { TypingController } from "./typing.js";
import { MessageSender } from "./sender.js";
import { MessageRouter } from "./router.js";
import { createLogger } from "../shared/logger.js";

// 保持对外导出兼容（ConnectionState 现已迁至 polling.ts）
export type { ConnectionState } from "./polling.js";

// ============== 宿主依赖（依赖注入）==============

/**
 * 窄接口：WechatEngine 只依赖 pi 的这三个方法，
 * 避免测试必须实现整个 ExtensionAPI。等义于 ports 层的 PiHost。
 */
export type WechatHost = PiHost;

export type WechatConfig = WechatApiOpts;

/**
 * 可注入的微信边界端口（测试用 fake；生产缺省时由本文件构造 adapters）。
 */
export interface WechatEnginePorts {
  inbound?: WechatInbound;
  outbound?: WechatOutbound;
  media?: WechatMedia;
}

/** createWechatEngine 可选的初始依赖（host / config / ports）。 */
export interface WechatEngineDeps extends WechatEnginePorts {
  host?: WechatHost;
  config?: WechatConfig;
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

  // === 运行时会话状态（凭证 / 配置 / 宿主 / 通知 / 终端标志 / 请求追踪）===
  private state = new ChannelState();

  // === 消息队列 / 忙闲 / 去重（抽到 TurnQueue）===
  private queue = new TurnQueue<{ msg: WeixinMessage; requestId: string }>();

  // === 媒体存储 / 后台串行队列（B5：媒体下载不阻塞轮询）===
  private readonly mediaStore: MediaStore;
  private mediaQueue = new SerialTaskQueue((err) =>
    this.logger.error("Media background task failed", err),
  );

  // === Typing / 发送 协作类（单用户）===
  private readonly typing: TypingController;
  private readonly sender: MessageSender;

  // === 消息路由（turn 执行 + 队列排空）===
  private router: MessageRouter;

  constructor(ports: WechatEnginePorts = {}) {
    const outbound =
      ports.outbound ??
      createWechatOutbound({
        getCredentials: () => this.getCredentials(),
        logger: this.logger,
      });
    const inbound = ports.inbound ?? createWechatInbound();
    const media =
      ports.media ??
      createWechatMedia({
        log: (message) => this.logger.debug(message),
        errLog: (message) => this.logger.error(message),
      });

    this.mediaStore = new MediaStore({
      media,
      log: (...a: unknown[]) => this.logger.debug(String(a[0] ?? ""), ...a.slice(1)),
      errLog: (...a: unknown[]) => this.logger.error(String(a[0] ?? ""), ...a.slice(1)),
    });

    this.typing = new TypingController({
      outbound,
      getContextToken: () => this.state.contextToken,
      debug: this.logger.debug.bind(this.logger),
      error: this.logger.error.bind(this.logger),
    });
    this.sender = new MessageSender({
      outbound,
      canSend: () => this.getCredentials() !== null,
      debug: this.logger.debug.bind(this.logger),
      error: this.logger.error.bind(this.logger),
    });

    this.router = new MessageRouter({
      queue: this.queue,
      mediaStore: this.mediaStore,
      mediaQueue: this.mediaQueue,
      sender: this.sender,
      getHost: () => this.state.host,
      getOpts: () => this.getCurrentOpts(),
      logger: this.logger,
    });

    this.poller = new PollingLoop({
      ensureSession: () => this.initSingleUser(),
      getAccountId: () => this.state.accountId,
      loadCursor: (accountId) => storage.loadSyncCursor(accountId),
      saveCursor: (accountId, cursor) => storage.saveSyncCursor(accountId, cursor),
      inbound,
      onMessage: (msg, opts) => this.handleMessage(msg, opts),
      onNeedsRelogin: () => {
        this.logger.debug("Session expired, needs relogin");
        this.state.notifier?.("微信登录已失效，请执行 /wechat login 重新登录", "error");
      },
      debug: this.logger.debug.bind(this.logger),
      error: this.logger.error.bind(this.logger),
      sleep,
    });
  }

  setHost(host: WechatHost): void {
    this.state.host = host;
  }

  setNotifier(notifier: Notifier): void {
    this.state.notifier = notifier;
  }

  setConfig(config: WechatConfig): void {
    this.state.config = config;
  }

  /** 可选字段各自覆盖：未提供的依赖保持不变。 */
  configure(deps: { host?: WechatHost; config?: WechatConfig }): void {
    if (deps.host) this.state.host = deps.host;
    if (deps.config) this.state.config = deps.config;
  }

  // === getter ===
  get connectionState(): ConnectionState {
    return this.poller.connectionState;
  }

  // === 终端处理状态 getter/setter（新增）===
  getTerminalProcessing(): boolean {
    return this.state.isTerminalMessageProcessing;
  }

  setTerminalProcessing(value: boolean): void {
    this.state.isTerminalMessageProcessing = value;
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

    this.state.userId = credentials.userId;
    this.state.accountId = credentials.accountId;

    // 加载 context token
    this.state.contextToken = await storage.getSingleUserContextToken();
    if (!this.state.contextToken) {
      this.logger.warn("No context token found, replies may fail");
    }

    this.logger.debug(`Single user initialized: userId=${this.state.userId}, contextToken=${this.state.contextToken ? 'present' : 'MISSING'}`);
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
  async startPolling(opts: WechatApiOpts): Promise<void> {
    await this.poller.start(opts);
  }

  /**
   * 处理收到的微信消息
   */
  async handleMessage(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
    // 单用户模式下，忽略消息来源（固定发给单用户）
    const requestId = this.generateRequestId();

    // 检查 slash command
    if (this.isSlashCommand(msg)) {
      await this.handleSlashCommand(msg, opts);
      return;
    }

    // 更新 contextToken（如果消息中有）
    if (msg.context_token && msg.context_token !== this.state.contextToken) {
      this.logger.debug(`Updating contextToken from message`);
      this.state.contextToken = msg.context_token;
      // contextToken 变化后旧 typing ticket 立即失效
      this.typing.invalidateTicket();
      // 持久化
      if (this.state.accountId && this.state.userId) {
        await storage.saveContextToken(this.state.accountId, this.state.userId, {
          displayName: this.state.userId,
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
  async triggerAi(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void> {
    // 只有当 AI 空闲且没有终端消息在处理时，才直接发送
    // 否则加入队列等待
    if (this.queue.isBusy() || this.state.isTerminalMessageProcessing) {
      // 加入队列
      this.queue.enqueue({ msg, requestId });
      this.logger.debug(`AI is ${this.queue.isBusy() ? 'processing' : 'terminal processing'}, queued message (queue size: ${this.queue.size})`);
      return;
    }

    await this.router.execute(msg, requestId, opts);
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
   *
   * 注：opts 目前未使用（保留参数以保持调用签名一致）。
   */
  private async handleSlashCommand(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
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
      void this.router.drain();
    }
  }

  private getCurrentOpts(): WechatApiOpts | null {
    const cfg = this.state.config;
    return cfg ? { baseUrl: cfg.baseUrl, token: cfg.token } : null;
  }

  // ============== Typing 相关（单用户）==============

  /**
   * 组装当前单用户凭证；任一缺失返回 null。
   */
  private getCredentials(): WechatCredentials | null {
    const config = this.state.config;
    if (!config || !this.state.userId || !this.state.contextToken) {
      return null;
    }
    return {
      baseUrl: config.baseUrl,
      token: config.token,
      userId: this.state.userId,
      contextToken: this.state.contextToken,
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

    // 清空会话状态：凭证 + 终端标志 + 请求追踪（config/host/notifier 保留）
    this.state.resetSession();

    // 轮询部分：generation 过期、abort、重建 controller、清 cursor/连接状态/失败计数
    this.poller.reset();

    this.logger.debug("Engine state reset");
  }

  // ============== 工具方法 ==============

  /**
   * 生成请求 ID
   * 格式: YYMMDDHHMMSSmmm + 3 位同毫秒序号（保证同一毫秒内也唯一）
   */
  private generateRequestId(): string {
    const now = Date.now();
    if (now !== this.state.lastRequestIdMs) {
      this.state.lastRequestIdMs = now;
      this.state.requestIdSeq = 0;
    } else {
      this.state.requestIdSeq += 1;
    }
    return `${formatTimestamp(new Date(now))}${String(this.state.requestIdSeq).padStart(3, "0")}`;
  }
}

// === 工厂函数（供测试隔离：创建不共享模块单例状态的独立实例）===
export function createWechatEngine(initial?: WechatEngineDeps): WechatEngine {
  const instance = new WechatEngine({
    inbound: initial?.inbound,
    outbound: initial?.outbound,
    media: initial?.media,
  });
  if (initial) instance.configure(initial);
  return instance;
}

// === 导出单例 ===
export const engine = new WechatEngine();
