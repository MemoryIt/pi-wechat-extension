/**
 * sender.ts - 出站消息发送器（单用户）
 *
 * 负责发送出站消息：
 * - 文本消息经 WechatOutbound.sendText
 * - 本地文件经 WechatOutbound.sendFile（显示名以 basename 为准，仅用于日志）
 * - sendWithRetry 指数退避 1000 * 2^(n-1)
 *
 * 最初自 wechat.ts 提取，行为保持不变；微信边界经端口访问。
 */

import path from "node:path";
import type { WechatOutbound } from "../ports/outbound.js";
import { sleep } from "../shared/time.js";

export interface SenderDeps {
  outbound: WechatOutbound;
  /** 凭证是否就绪；缺凭证时 sendWithRetry 入口立即报错，不进入重试。 */
  canSend(): boolean;
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export class MessageSender {
  constructor(private deps: SenderDeps) {}

  /**
   * 使用官方 sendMessageWeixin 发送纯文字消息（推荐！）
   */
  async sendText(text: string): Promise<void> {
    this.deps.debug(`sendTextMessage: text length=${text.length}`);

    await this.deps.outbound.sendText(text);
    this.deps.debug(`sendTextMessage: 文字消息发送成功`);
  }

  /**
   * 向微信发送本地文件 —— 直接使用官方 sendWeixinMediaFile（自动路由图片/视频/文件）
   */
  async sendFile(localPath: string): Promise<void> {
    // 底层 sendWeixinMediaFile 不支持自定义显示名，显示名以本地文件 basename 为准，
    // 因此不再接收/透传 fileName。
    if (!localPath || typeof localPath !== "string") {
      throw new Error("sendFileToUser: localPath 不能为空");
    }

    const displayName = path.basename(localPath);
    this.deps.debug(
      `sendFileToUser START: localPath=${localPath}, displayName=${displayName} (使用官方 sendWeixinMediaFile)`,
    );

    await this.deps.outbound.sendFile(localPath);

    this.deps.debug(
      `sendFileToUser COMPLETE: 文件 "${displayName}" 已通过官方 sendWeixinMediaFile 发送成功`,
    );
  }

  /**
   * 发送消息到微信（带重试）
   *
   * 入口先检查凭证：缺凭证时立即抛 `"Single user not initialized"`，
   * 不调用底层发送、不进入重试、不 sleep（与旧实现一致）。
   */
  async sendWithRetry(text: string, maxRetries: number = 3): Promise<void> {
    if (!this.deps.canSend()) {
      throw new Error("Single user not initialized");
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendText(text);
        return;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const errMsg = lastError.message;
        this.deps.error(`[Wechat] sendMessage attempt ${attempt} failed:`, errMsg);
        if (attempt < maxRetries) {
          await sleep(1000 * Math.pow(2, attempt - 1));
        }
      }
    }

    throw lastError ?? new Error("sendMessage failed");
  }
}
