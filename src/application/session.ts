/**
 * session.ts - 会话生命周期用例（应用层）
 *
 * 承载「会话生命周期」的唯一入口：
 * - `session_start` 自动连接（startFromStoredToken）
 * - `/wechat login|start|stop|logout|status` 各子命令
 * - `session_shutdown` 关闭（shutdown）
 *
 * 所有「启动轮询」路径共用同一个私有方法 `startPollingWith`：
 * `setConfig` 与 `startPolling(opts)` 只在该处出现一次，消除双凭证来源的分叉。
 *
 * 依赖方向：只 import `../storage/state.js`（凭证读写）、`../ports/auth.js`
 * （扫码登录端口）、`../shared/*`（日志 / 脱敏 / 类型），不感知 pi / Channel / vendor。
 */

import type { WechatApiOpts } from "../shared/types.js";
import type { PluginLogger } from "../shared/logger.js";
import {
  getDefaultAccountToken,
  deleteAccountData,
  removeAccount,
  saveToken,
  upsertAccount,
} from "../storage/state.js";
import type { WechatAuth } from "../ports/auth.js";
import { redactToken } from "../shared/redact.js";

/** 应用层所需的 UI 能力：通知、控制台日志、二维码展示。 */
export interface SessionUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  log(message: string): void;
  showQr(qrcodeUrl: string): void;
}

/** `SessionService` 所需的最小通道能力（窄接口）。 */
export interface SessionChannel {
  readonly connectionState: string;
  setConfig(config: WechatApiOpts): void;
  startPolling(opts: WechatApiOpts): Promise<void>;
  stopPolling(): void;
  reset(): void;
}

/**
 * 会话生命周期用例。
 *
 * 行为不变性：所有 ui.notify 文案、二维码展示、登录成功摘要（脱敏）、
 * 存储调用集合、轮询错误提示均与迁移前逐字一致（见 rf-2 行为契约）。
 */
export class SessionService {
  private readonly channel: SessionChannel;
  private readonly auth: WechatAuth;
  private readonly logger: PluginLogger;

  constructor(deps: { channel: SessionChannel; auth: WechatAuth; logger: PluginLogger }) {
    this.channel = deps.channel;
    this.auth = deps.auth;
    this.logger = deps.logger;
  }

  /** `session_start` 自动连接：有 token 则同步凭证并启动轮询，无 token 仅 debug。 */
  async startFromStoredToken(ui: SessionUi): Promise<void> {
    const token = await getDefaultAccountToken();
    if (token) {
      this.startPollingWith(
        { baseUrl: token.baseUrl, token: token.botToken },
        (err) => this.logger.error("Polling error:", err.message),
        () => this.logger.debug(`session_start: loaded token for userId=${token.userId}`),
      );
    } else {
      this.logger.debug("session_start: no logged in account found");
    }
  }

  /** `/wechat login`：二维码扫码登录，成功后持久化凭证并自动启动轮询。 */
  async login(ui: SessionUi): Promise<void> {
    try {
      const startResult = await this.auth.startQr({
        apiBaseUrl: "https://ilinkai.weixin.qq.com",
        verbose: true,
      });

      if (!startResult.qrcodeUrl) {
        ui.notify(`Failed to get QR code: ${startResult.message}`, "error");
        return;
      }

      ui.notify("请使用微信扫描二维码...", "info");
      ui.showQr(startResult.qrcodeUrl);

      const loginResult = await this.auth.waitForLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: "https://ilinkai.weixin.qq.com",
        timeoutMs: 480_000,
        verbose: true,
      });

      if (loginResult.connected) {
        const accountId = loginResult.accountId!;
        const botToken = loginResult.botToken!;

        await saveToken(accountId, {
          botToken,
          accountId,
          userId: loginResult.userId!,
          baseUrl: loginResult.baseUrl!,
          loginAt: Date.now(),
        });

        await upsertAccount({
          accountId,
          displayName: "微信账号",
          loginAt: Date.now(),
        });

        ui.notify("✅ 与微信连接成功！", "info");

        this.startPollingWith(
          { baseUrl: loginResult.baseUrl!, token: botToken },
          (err) => ui.notify(`启动轮询失败: ${err.message}`, "error"),
        );

        // 不打印明文凭证，仅输出脱敏后的字段（D11）。
        ui.log("\n=== 登录成功 ===");
        ui.log(
          JSON.stringify(
            {
              botToken: redactToken(botToken),
              accountId,
              userId: loginResult.userId,
              baseUrl: loginResult.baseUrl,
            },
            null,
            2,
          ),
        );
        ui.log("================\n");
      } else {
        ui.notify(`登录失败: ${loginResult.message}`, "error");
      }
    } catch (err) {
      this.logger.debug("performWechatLogin failed:", err);
      ui.notify(`登录异常: ${String(err)}`, "error");
    }
  }

  /** `/wechat start`：有 token 则启动轮询，无 token 提示先登录。 */
  async start(ui: SessionUi): Promise<void> {
    const token = await getDefaultAccountToken();
    if (!token) {
      ui.notify("WeChat: Not logged in. Use /wechat login first.", "error");
      return;
    }
    this.startPollingWith(
      { baseUrl: token.baseUrl, token: token.botToken },
      (err) => ui.notify(`Polling error: ${err.message}`, "error"),
      () => ui.notify("WeChat: Starting polling...", "info"),
    );
  }

  /** `/wechat stop`：停止轮询。 */
  stop(ui: SessionUi): void {
    this.channel.stopPolling();
    ui.notify("WeChat: Stopped polling", "info");
  }

  /** `/wechat logout`：重置通道并删除本地账户数据。 */
  async logout(ui: SessionUi): Promise<void> {
    this.channel.reset();
    const token = await getDefaultAccountToken();
    if (token) {
      await deleteAccountData(token.accountId);
      await removeAccount(token.accountId);
      ui.notify("WeChat: Logged out successfully", "info");
    } else {
      ui.notify("WeChat: Not logged in", "info");
    }
  }

  /** `/wechat status`：当前登录状态与连接状态。 */
  async status(ui: SessionUi): Promise<void> {
    const token = await getDefaultAccountToken();
    if (token) {
      ui.notify(
        `WeChat: Logged in\nUser ID: ${token.userId}\nConnection: ${this.channel.connectionState}`,
        "info",
      );
    } else {
      ui.notify("WeChat: Not logged in", "info");
    }
  }

  /** `session_shutdown`：停止轮询并重置通道。 */
  shutdown(): void {
    this.channel.stopPolling();
    this.channel.reset();
  }

  /**
   * 所有启动轮询路径的唯一入口：先同步凭证到 channel（setConfig），再 startPolling。
   * 失败统一走 `onError`；可选 `afterSetConfig` 供调用方在 setConfig 之后、startPolling
   * 之前插入通知 / 日志，保持与原时序一致。
   */
  private startPollingWith(
    opts: WechatApiOpts,
    onError: (err: { message: string }) => void,
    afterSetConfig?: () => void,
  ): void {
    this.channel.setConfig(opts);
    afterSetConfig?.();
    void this.channel.startPolling(opts).catch(onError);
  }
}