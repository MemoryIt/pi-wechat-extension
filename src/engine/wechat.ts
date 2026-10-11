/**
 * wechat.ts - 微信引擎薄门面 / 组合根（单用户版本）
 *
 * 通道编排逻辑已下沉到 `../channel/channel.ts` 的 `Channel`；本类仅持有
 * 一个 `Channel` 实例并把所有公共成员**逐一委托**给它，保持对外公共 API
 * 逐成员不变。
 *
 * 对外提供 WechatHost 依赖注入、WechatConfig 与 createWechatEngine() 工厂；
 * 不再导出模块级 `engine` 单例 / `setPi` / `setConfig`（组合根见 `src/index.ts`）。
 */

import type { WeixinMessage } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatMedia } from "../ports/media.js";
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";
import type { Notifier } from "../channel/state.js";
import { Channel } from "../channel/channel.js";

// 保持对外导出兼容（ConnectionState 现已迁至 channel/polling.ts）
export type { ConnectionState } from "../channel/polling.js";

// ============== 宿主依赖（依赖注入）==============

/**
 * 窄接口：WechatEngine 只依赖 pi 的这三个方法，
 * 避免测试必须实现整个 ExtensionAPI。等义于 ports 层的 PiHost。
 */
export type WechatHost = PiHost;

export type WechatConfig = WechatApiOpts;

/**
 * 可注入的微信边界端口（测试用 fake；生产缺省时由 Channel 构造 adapters）。
 */
export interface WechatEnginePorts {
  inbound?: WechatInbound;
  outbound?: WechatOutbound;
  media?: WechatMedia;
}

/**
 * createWechatEngine 可选的初始依赖。
 *
 * 兼容两种写法：顶层 `{ inbound, outbound, media }`（旧）与嵌套
 * `{ ports: { inbound, outbound, media } }`（PA-5 起）。
 */
export interface WechatEngineDeps extends WechatEnginePorts {
  host?: WechatHost;
  config?: WechatConfig;
  ports?: WechatEnginePorts;
}

// ============== WechatEngine（单用户版本，薄门面）==============

export class WechatEngine {
  /** 通道编排器：引擎不再直接持有协作类/状态逻辑，仅委托。 */
  private channel: Channel;

  constructor(ports: WechatEnginePorts = {}) {
    this.channel = new Channel({ ports });
  }

  setHost(host: WechatHost): void {
    this.channel.setHost(host);
  }

  setNotifier(notifier: Notifier): void {
    this.channel.setNotifier(notifier);
  }

  setConfig(config: WechatConfig): void {
    this.channel.setConfig(config);
  }

  /** 可选字段各自覆盖：未提供的依赖保持不变。 */
  configure(deps: { host?: WechatHost; config?: WechatConfig }): void {
    this.channel.configure(deps);
  }

  get connectionState() {
    return this.channel.connectionState;
  }

  getTerminalProcessing(): boolean {
    return this.channel.getTerminalProcessing();
  }

  setTerminalProcessing(value: boolean): void {
    this.channel.setTerminalProcessing(value);
  }

  /**
   * 初始化单用户凭证（原 initSingleUser）。
   */
  async initSingleUser(): Promise<boolean> {
    return this.channel.initSession();
  }

  /** 停止长轮询（委托 Channel）。 */
  stopPolling(): void {
    this.channel.stopPolling();
  }

  /** 启动长轮询（委托 Channel）。 */
  async startPolling(opts: WechatApiOpts): Promise<void> {
    return this.channel.startPolling(opts);
  }

  /** 处理收到的微信消息（委托 Channel）。 */
  async handleMessage(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
    return this.channel.handleMessage(msg, opts);
  }

  /** 触发 AI 处理消息（委托 Channel）。 */
  async triggerAi(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void> {
    return this.channel.triggerAi(msg, requestId, opts);
  }

  /** AI 处理完成（委托 Channel）。 */
  onAiDone(): void {
    this.channel.onAiDone();
  }

  // ============== Typing 相关（单用户）==============

  async getTypingTicket(): Promise<string | null> {
    return this.channel.getTypingTicket();
  }

  async sendTypingStatus(status: 1 | 2): Promise<void> {
    return this.channel.sendTypingStatus(status);
  }

  async startTypingKeepalive(): Promise<void> {
    return this.channel.startTyping();
  }

  async stopTypingKeepalive(): Promise<void> {
    return this.channel.stopTyping();
  }

  // ============== 发送消息（单用户）==============

  async sendTextMessage(text: string): Promise<void> {
    return this.channel.sendText(text);
  }

  async sendFileToUser(localPath: string): Promise<void> {
    return this.channel.sendFile(localPath);
  }

  async sendMessageWithRetry(text: string, maxRetries: number = 3): Promise<void> {
    return this.channel.sendReply(text, maxRetries);
  }

  // ============== 防重相关 ==============

  getCurrentRequestId(): string | null {
    return this.channel.getCurrentRequestId();
  }

  isRequestProcessed(requestId: string): boolean {
    return this.channel.isRequestProcessed(requestId);
  }

  markRequestProcessed(requestId: string): void {
    this.channel.markRequestProcessed(requestId);
  }

  cleanupProcessedRequests(): void {
    this.channel.cleanupProcessedRequests();
  }

  // ============== 重置 ==============

  reset(): void {
    this.channel.reset();
  }
}

// === 工厂函数（供测试隔离：创建不共享模块单例状态的独立实例）===
export function createWechatEngine(initial?: WechatEngineDeps): WechatEngine {
  // 兼容顶层 flat ports 与嵌套 ports 两种写法；嵌套优先。
  const ports: WechatEnginePorts = initial?.ports ?? {
    inbound: initial?.inbound,
    outbound: initial?.outbound,
    media: initial?.media,
  };
  const instance = new WechatEngine(ports);
  if (initial) instance.configure(initial);
  return instance;
}
