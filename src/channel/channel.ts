/**
 * channel/channel.ts - 微信通道粗粒度编排器
 *
 * 承载单用户通道的编排逻辑：构造函数委托 `createChannelRuntime` 完成装配，
 * 自身只持有运行时协作类（`PollingLoop` / `TypingController` / `MessageSender` /
 * `MessageRouter` / `InboundHandler` / `CredentialLoader`）并对外委托行为。
 * turn 队列由 `MessageRouter` 拥有并集中管理状态迁移（见 `router.ts`）。
 *
 * 装配细节（`new` 与回调注入）见 `create-channel.ts`；本类不直接构造协作类。
 *
 * 依赖方向单向：`channel/*` 只依赖 `ports/`、`storage/` 与 `shared/`，不 import
 * 微信侧适配层或 `../engine/*`；宿主依赖使用 `ports/pi-host` 的 `PiHost`。
 * 端口实现与 `ChannelState` 由组合根（`src/index.ts`）组装后经 `ChannelDeps.ports` 注入。
 */

import type { WeixinMessage } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatMedia } from "../ports/media.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import type { PluginLogger } from "../shared/logger.js";
import type { ChannelState, Notifier } from "./state.js";
import type { PollingLoop, ConnectionState } from "./polling.js";
import type { TypingController } from "./typing.js";
import type { MessageSender } from "./sender.js";
import type { MessageRouter } from "./router.js";
import type { InboundHandler } from "./inbound-handler.js";
import type { CredentialLoader } from "./credential-loader.js";
import { createChannelRuntime } from "./create-channel.js";

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
  private readonly credentialLoader: CredentialLoader;
  private readonly poller: PollingLoop;

  private readonly typing: TypingController;
  private readonly sender: MessageSender;
  private readonly router: MessageRouter;
  private readonly inboundHandler: InboundHandler;

  constructor(deps: ChannelDeps) {
    const runtime = createChannelRuntime(deps);
    this.state = runtime.state;
    this.logger = runtime.logger;
    this.credentialLoader = runtime.credentialLoader;
    this.poller = runtime.poller;
    this.typing = runtime.typing;
    this.sender = runtime.sender;
    this.router = runtime.router;
    this.inboundHandler = runtime.inboundHandler;
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
}
