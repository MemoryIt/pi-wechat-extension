/**
 * channel/channel.ts - 微信通道粗粒度编排器
 *
 * 承载单用户通道的编排逻辑：持有 `ChannelState` 与各协作类
 * （`PollingLoop` / `SerialTaskQueue` / `MediaStore` /
 * `TypingController` / `MessageSender` / `MessageRouter` / `InboundHandler`），
 * 并装配为完整通道。
 * turn 队列由 `MessageRouter` 拥有并集中管理状态迁移（见 `router.ts`）。
 *
 * 依赖方向单向：`channel/*` 只依赖 `ports/`、`storage/` 与 `shared/`，不 import
 * 微信侧适配层或 `../engine/*`；宿主依赖使用 `ports/pi-host` 的 `PiHost`。
 * 端口实现与 `ChannelState` 由组合根（`src/index.ts`）组装后经 `ChannelDeps.ports` 注入。
 */

import type { WeixinMessage, WechatCredentials } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatMedia } from "../ports/media.js";
import * as storage from "../storage/state.js";
import { isDebugEnabled } from "../shared/config.js";
import { sleep as defaultSleep } from "../shared/time.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import type { PluginLogger } from "../shared/logger.js";
import { createLogger } from "../shared/logger.js";
import { ChannelState } from "./state.js";
import type { Notifier } from "./state.js";
import { RequestIdGenerator } from "./request-id.js";
import { PollingLoop } from "./polling.js";
import type { ConnectionState } from "./polling.js";
import { SerialTaskQueue } from "./queue.js";
import { TypingController } from "./typing.js";
import { MessageSender } from "./sender.js";
import { MessageRouter } from "./router.js";
import { MediaStore } from "./media-store.js";
import { InboundHandler } from "./inbound-handler.js";
import { createCredentialLoader } from "./credential-loader.js";
import type { CredentialLoader } from "./credential-loader.js";

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
  private readonly credentialLoader: CredentialLoader;
  private readonly poller: PollingLoop;

  private readonly mediaStore: MediaStore;
  private readonly mediaQueue: SerialTaskQueue;
  private readonly typing: TypingController;
  private readonly sender: MessageSender;
  private readonly router: MessageRouter;
  private readonly inboundHandler: InboundHandler;

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
      mediaStore: this.mediaStore,
      mediaQueue: this.mediaQueue,
      sender: this.sender,
      getHost: () => this.state.host,
      getOpts: () => this.getCurrentOpts(),
      isTerminalProcessing: () => this.state.isTerminalMessageProcessing,
      logger: this.logger,
    });

    this.inboundHandler = new InboundHandler({
      state: this.state,
      typing: this.typing,
      router: this.router,
      requestId: new RequestIdGenerator(),
      logger: this.logger,
    });

    this.credentialLoader = createCredentialLoader({
      state: this.state,
      logger: this.logger,
    });

    this.poller = new PollingLoop({
      ensureSession: () => this.credentialLoader.ensureSession(),
      getAccountId: () => this.state.accountId,
      loadCursor: (accountId) => storage.loadSyncCursor(accountId),
      saveCursor: (accountId, cursor) => storage.saveSyncCursor(accountId, cursor),
      inbound,
      onMessage: (msg, opts) => this.inboundHandler.handle(msg, opts),
      onNeedsRelogin: () => {
        this.logger.debug("Session expired, needs relogin");
        this.state.notifier?.("微信登录已失效，请执行 /wechat login 重新登录", "error");
      },
      debug: this.logger.debug.bind(this.logger),
      error: this.logger.error.bind(this.logger),
      sleep: this.sleep,
    });
  }

  // ============== 公共 API（facade for bridge / application / tests）==============
  // 窄接口面：bridge 用 BridgeChannel（setNotifier / startTyping / stopTyping /
  // setTerminalProcessing）、application 用 ReplyChannel / SessionChannel、
  // tool-send-file 用 { sendFile }；tests 直接测 Channel 自身。

  setHost(host: PiHost): void {
    this.state.host = host;
  }

  setNotifier(notifier: Notifier): void {
    this.state.notifier = notifier;
  }

  setConfig(config: WechatApiOpts): void {
    this.state.config = config;
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
   * 委托 `CredentialLoader`；签名与行为保持不变，session_start 时调用。
   */
  async initSession(): Promise<boolean> {
    return this.credentialLoader.ensureSession();
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
   * 处理收到的微信消息：contextToken 更新 / 触发 turn。
   * 委托 `InboundHandler`；签名与行为保持不变。
   */
  async handleMessage(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
    return this.inboundHandler.handle(msg, opts);
  }

  /**
   * 触发 AI 处理消息（单用户模式，无需 userId 参数）。
   */
  async triggerAi(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void> {
    // 编排（忙/终端 -> 入队，否则执行）由 MessageRouter 统一负责。
    await this.router.dispatch(msg, requestId, opts);
  }

  /** AI 处理完成：释放队列并继续排空。 */
  onAiDone(): void {
    this.router.onTurnDone();
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
    return this.router.queue.getCurrentRequestId();
  }

  isRequestProcessed(requestId: string): boolean {
    return this.router.queue.isRequestProcessed(requestId);
  }

  markRequestProcessed(requestId: string): void {
    this.router.queue.markRequestProcessed(requestId);
  }

  // ============== 重置 ==============

  reset(): void {
    this.typing.reset();

    this.router.queue.reset();

    // 清空会话状态：凭证 + 终端标志（config/host/notifier 保留）
    this.state.resetSession();

    // 轮询部分：generation 过期、abort、重建 controller、清 cursor/连接状态/失败计数
    this.poller.reset();

    this.logger.debug("Channel state reset");
  }

  // ============== 私有工具 ==============

  private getCurrentOpts(): WechatApiOpts | null {
    return this.state.getOpts();
  }

  /**
   * 组装当前单用户凭证；任一缺失返回 null。
   */
  private getCredentials(): WechatCredentials | null {
    return this.state.getCredentials();
  }
}
