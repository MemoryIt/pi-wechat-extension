/**
 * channel/credential-loader.ts - 单用户凭证加载协作类
 *
 * 承载「从 storage 读取单用户凭证并写入运行期 `ChannelState`」这段会话基础设施
 * 协作逻辑（原 `Channel.initSession()` 内联实现）。凭证加载不应由通道编排器承担，
 * 故抽为独立协作类，由 `Channel` 持有并对外委托。
 *
 * 行为契约（与抽取前 `Channel.initSession()` 逐字一致）：
 * - 顺序：先 `storage.getSingleUserCredentials()`；**仅当拿到 credentials** 时才
 *   `storage.getSingleUserContextToken()`。
 * - 无 credentials：`logger.error("No logged in account found")`，返回 `false`，
 *   不改动 state。
 * - 有 credentials：写 `state.userId` / `state.accountId`，再写 `state.contextToken`。
 * - 无 contextToken：`logger.warn("No context token found, replies may fail")`，仍返回 `true`。
 * - 日志：`logger.debug("Single user initialized: userId=<id>, contextToken=present|MISSING")`。
 */

import * as storage from "../storage/state.js";
import type { ChannelState } from "./state.js";
import type { PluginLogger } from "../shared/logger.js";

/** CredentialLoader 的注入依赖。 */
export interface CredentialLoaderDeps {
  state: ChannelState;
  logger: PluginLogger;
}

/** 单用户凭证加载协作类。 */
export class CredentialLoader {
  private readonly state: ChannelState;
  private readonly logger: PluginLogger;

  constructor(deps: CredentialLoaderDeps) {
    this.state = deps.state;
    this.logger = deps.logger;
  }

  /**
   * 初始化单用户凭证（原 `Channel.initSession`）。
   * 从 storage 载入凭证到 state；session_start 时调用。
   */
  async ensureSession(): Promise<boolean> {
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
}

/** 工厂：创建 `CredentialLoader`。 */
export function createCredentialLoader(deps: CredentialLoaderDeps): CredentialLoader {
  return new CredentialLoader(deps);
}
