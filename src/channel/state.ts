/**
 * channel/state.ts - 通道运行时会话状态
 *
 * 从 `WechatEngine` 抽出的可变态：单用户凭证、运行期注入依赖（config/host/notifier）、
 * 终端消息处理标志与请求 ID 追踪。
 *
 * 只依赖 `shared/types` 与 `ports/pi-host`，不反向依赖 engine，避免 channel → engine
 * 的依赖倒置；协作类（PollingLoop / TurnQueue / TypingController / MessageSender /
 * MessageRouter / MediaStore / SerialTaskQueue）仍保持独立，不并入此处。
 */

import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";

/** 会话过期等场景的用户通知回调（B4）。 */
export type Notifier = (message: string, type?: "info" | "warning" | "error") => void;

export class ChannelState {
  // === 单用户凭证（运行时加载）===
  accountId: string | null = null;
  userId: string | null = null;
  contextToken: string | null = null;

  // === 运行期注入依赖（跨 reset 保留）===
  config: WechatApiOpts | null = null;
  host: PiHost | null = null;
  notifier: Notifier | null = null;

  // === 终端消息处理状态 ===
  isTerminalMessageProcessing = false;

  // === 请求追踪（仅 requestId）===
  lastRequestIdMs = -1;
  requestIdSeq = 0;

  /**
   * 清理会话级状态：凭证、终端处理标志与请求追踪计数。
   *
   * 保留 `config` / `host` / `notifier`（与旧 `WechatEngine.reset()` 对这些字段的
   * 处理一致：它们跨 reset 存续，不清空）。
   */
  resetSession(): void {
    this.accountId = null;
    this.userId = null;
    this.contextToken = null;

    this.isTerminalMessageProcessing = false;
    this.lastRequestIdMs = -1;
    this.requestIdSeq = 0;
  }
}
