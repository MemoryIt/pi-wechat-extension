/**
 * channel/state.ts - 通道运行时会话状态
 *
 * 从通道编排器抽出的可变态：单用户凭证、运行期注入依赖（config/host/notifier）
 * 与终端消息处理标志。requestId 追踪已迁出到独立的 `RequestIdGenerator`
 * （见 `request-id.ts`），此处不再承载。
 *
 * 只依赖 `shared/types` 与 `ports/pi-host`，不反向依赖 engine，避免 channel → engine
 * 的依赖倒置；协作类（PollingLoop / TurnQueue / TypingController / MessageSender /
 * MessageRouter / MediaStore / SerialTaskQueue）仍保持独立，不并入此处。
 */

import type { WechatApiOpts } from "../shared/types.js";
import type { WechatCredentials } from "../ports/types.js";
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

  /**
   * 清理会话级状态：凭证与终端处理标志。
   *
   * 保留 `config` / `host` / `notifier`（与旧编排器 `reset()` 对这些字段的
   * 处理一致：它们跨 reset 存续，不清空）。
   */
  resetSession(): void {
    this.accountId = null;
    this.userId = null;
    this.contextToken = null;

    this.isTerminalMessageProcessing = false;
  }

  /**
   * 组装当前单用户凭证；任一缺失（config / userId / contextToken）返回 null。
   *
   * 供组合根在构造 outbound adapter 时注入（`getCredentials` provider），
   * 与通道自身发送/typing 使用同一份状态。
   */
  getCredentials(): WechatCredentials | null {
    const config = this.config;
    if (!config || !this.userId || !this.contextToken) {
      return null;
    }
    return {
      baseUrl: config.baseUrl,
      token: config.token,
      userId: this.userId,
      contextToken: this.contextToken,
    };
  }

  /** 当前 API 调用选项（baseUrl + token）；未配置时返回 null。 */
  getOpts(): WechatApiOpts | null {
    const cfg = this.config;
    return cfg ? { baseUrl: cfg.baseUrl, token: cfg.token } : null;
  }
}
