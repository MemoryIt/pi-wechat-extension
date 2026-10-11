/**
 * channel/channel.ts - 微信通道粗粒度编排器
 *
 * 承载单用户通道的编排逻辑：持有 `ChannelState` 与各协作类
 * （`PollingLoop` / `TurnQueue` / `SerialTaskQueue` / `MediaStore` /
 * `TypingController` / `MessageSender` / `MessageRouter`），并装配为完整通道。
 *
 * 依赖方向单向：`channel/*` 只依赖 `ports/`、`storage/` 与 `shared/`，不 import
 * 微信侧适配层或 `../engine/*`；宿主依赖使用 `ports/pi-host` 的 `PiHost`。
 * 端口实现与 `ChannelState` 由组合根（`src/index.ts`）组装后经 `ChannelDeps.ports` 注入。
 */

import type { WeixinMessage, WechatCredentials } from "../ports/types.js";
import { MessageItemType } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatMedia } from "../ports/media.js";
import * as storage from "../storage/state.js";
import { isDebugEnabled } from "../shared/config.js";
import { sleep as defaultSleep, formatTimestamp } from "../shared/time.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import type { PluginLogger } from "../shared/logger.js";
import { createLogger } from "../shared/logger.js";
import { ChannelState } from "./state.js";
import type { Notifier } from "./state.js";
import { PollingLoop } from "./polling.js";
import type { ConnectionState } from "./polling.js";
import { TurnQueue, SerialTaskQueue } from "./queue.js";
import { TypingController } from "./typing.js";
import { MessageSender } from "./sender.js";
import { MessageRouter } from "./router.js";
import { MediaStore } from "./media-store.js";

/** 微信边界端口（生产由组合根注入真实端口实现；测试注入 fake）。 */
export interface ChannelPorts {
  inbound: WechatInbound;
  outbound: WechatOutbound;
  media: WechatMedia;
}

/** Channel 可选的初始依赖。 */
export interface ChannelDeps {
  state?: ChannelState;
  host?: PiHost;
  config?: WechatApiOpts;
  notifier?: Notifier;
  ports: ChannelPorts;
  logger?: PluginLogger;
  sleep?: (ms: number) => Promise<void>;
}

export class Channel {
  readonly state: ChannelState;

  private readonly logger: PluginLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly poller: PollingLoop;

  private readonly queue = new TurnQueue<{ msg: WeixinMessage; requestId: string }>();
  private readonly mediaStore: MediaStore;
  private readonly mediaQueue: SerialTaskQueue;
  private readonly typing: TypingController;
  private readonly sender: MessageSender;
  private readonly router: MessageRouter;

  constructor(deps: ChannelDeps) {
    this.state = deps.state ?? new ChannelState();
    if (deps.host) this.state.host = deps.host;
    if (deps.config) this.state.config = deps.config;
    if (deps.notifier) this.state.notifier = deps.notifier;

    this.logger = deps.logger ?? createLogger({ isDebugEnabled: () => isDebugEnabled() });
    this.sleep = deps.sleep ?? defaultSleep;
    this.mediaQueue = new SerialTaskQueue((err) =>
      this.logger.error("Media background task failed", err),
    );

    const { inbound, outbound, media } = deps.ports;

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
      ensureSession: () => this.initSession(),
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
      sleep: this.sleep,
    });
  }

  setHost(host: PiHost): void {
    this.state.host = host;
  }

  setNotifier(notifier: Notifier): void {
    this.state.notifier = notifier;
  }

  setConfig(config: WechatApiOpts): void {
    this.state.config = config;
  }

  /** 可选字段各自覆盖：未提供的依赖保持不变。 */
  configure(deps: { host?: PiHost; config?: WechatApiOpts }): void {
    if (deps.host) this.state.host = deps.host;
    if (deps.config) this.state.config = deps.config;
  }

  get connectionState(): ConnectionState {
    return this.poller.connectionState;
  }

  getTerminalProcessing(): boolean {
    return this.state.isTerminalMessageProcessing;
  }

  setTerminalProcessing(value: boolean): void {
    this.state.isTerminalMessageProcessing = value;
  }

  /**
   * 初始化单用户凭证（原 initSingleUser）。
   * 从 storage 载入凭证到 state；session_start 时调用。
   */
  async initSession(): Promise<boolean> {
    const credentials = await storage.getSingleUserCredentials();
    if (!credentials) {
      this.logger.error("No logged in account found");
      return false;
    }

    this.state.userId = credentials.userId;
    this.state.accountId = credentials.accountId;

    this.state.contextToken = await storage.getSingleUserContextToken();
    if (!this.state.contextToken) {
      this.logger.warn("No context token found, replies may fail");
    }

    this.logger.debug(
      `Single user initialized: userId=${this.state.userId}, contextToken=${this.state.contextToken ? "present" : "MISSING"}`,
    );
    return true;
  }

  /** 停止长轮询（委托 PollingLoop）。 */
  stopPolling(): void {
    this.poller.stop();
  }

  /** 启动长轮询（委托 PollingLoop）。 */
  async startPolling(opts: WechatApiOpts): Promise<void> {
    await this.poller.start(opts);
  }

  /**
   * 处理收到的微信消息：slash / contextToken 更新 / 触发 turn。
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
   * 触发 AI 处理消息（单用户模式，无需 userId 参数）。
   */
  async triggerAi(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void> {
    // 只有当 AI 空闲且没有终端消息在处理时，才直接发送
    // 否则加入队列等待
    if (this.queue.isBusy() || this.state.isTerminalMessageProcessing) {
      this.queue.enqueue({ msg, requestId });
      this.logger.debug(
        `AI is ${this.queue.isBusy() ? "processing" : "terminal processing"}, queued message (queue size: ${this.queue.size})`,
      );
      return;
    }

    await this.router.execute(msg, requestId, opts);
  }

  /** AI 处理完成：释放队列并继续排空。 */
  onAiDone(): void {
    this.queue.setBusy(false);
    this.queue.setCurrentRequestId(null);

    if (this.queue.size > 0) {
      void this.router.drain();
    }
  }

  // ============== Typing 相关（单用户）==============

  /** 获取 typing_ticket（单用户）。 */
  async getTypingTicket(): Promise<string | null> {
    return this.typing.getTicket();
  }

  /** 发送 typing 状态（单用户）。 */
  async sendTypingStatus(status: 1 | 2): Promise<void> {
    return this.typing.sendStatus(status);
  }

  /** 开始 typing keepalive（单用户）。 */
  async startTyping(): Promise<void> {
    return this.typing.startKeepalive();
  }

  /** 停止 typing keepalive（单用户）。 */
  async stopTyping(): Promise<void> {
    return this.typing.stopKeepalive();
  }

  // ============== 发送消息（单用户）==============

  /** 发送纯文字消息（底层官方文本发送接口）。 */
  async sendText(text: string): Promise<void> {
    return this.sender.sendText(text);
  }

  /** 向微信发送本地文件（底层官方媒体发送接口，自动路由类型）。 */
  async sendFile(localPath: string): Promise<void> {
    return this.sender.sendFile(localPath);
  }

  /** 发送消息到微信（带重试；原 sendMessageWithRetry）。 */
  async sendReply(text: string, maxRetries: number = 3): Promise<void> {
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

    this.logger.debug("Channel state reset");
  }

  // ============== 私有工具 ==============

  /**
   * 提取消息中所有文本项拼接后的内容。
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
   * 检查是否是 slash command（遍历所有 item，不再只看首条 / 不再用魔法数字）。
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
   * 处理 slash command。
   *
   * 注：opts 目前未使用（保留参数以保持调用签名一致）。
   */
  private async handleSlashCommand(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
    const trimmed = this.extractText(msg).trim();

    if (trimmed === "/help") {
      await this.sendText("可用命令: /help");
    }
  }

  private getCurrentOpts(): WechatApiOpts | null {
    return this.state.getOpts();
  }

  /**
   * 组装当前单用户凭证；任一缺失返回 null。
   */
  private getCredentials(): WechatCredentials | null {
    return this.state.getCredentials();
  }

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
