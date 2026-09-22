/**
 * sender.ts - 出站消息发送器（单用户）
 *
 * 负责发送出站消息：
 * - 文本消息走官方 sendMessageWeixin
 * - 本地文件走官方 sendWeixinMediaFile（显示名以 basename 为准）
 * - sendWithRetry 指数退避 1000 * 2^(n-1)
 *
 * 最初自 wechat.ts 提取，行为保持不变。
 */

import path from "node:path";
import { sendMessageWeixin } from "../../messaging/send.js";
import { sendWeixinMediaFile } from "../../messaging/send-media.js";
import type { WeixinApiOptions } from "../../api/api.js";
import type { TypingCredentials } from "./typing.js";
import { sleep } from "../shared/time.js";

export interface SenderDeps {
  getCredentials(): TypingCredentials | null;
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export class MessageSender {
  constructor(private deps: SenderDeps) {}

  /**
   * 使用官方 sendMessageWeixin 发送纯文字消息（推荐！）
   */
  async sendText(text: string): Promise<void> {
    const creds = this.deps.getCredentials();
    if (!creds) {
      throw new Error("Single user not initialized");
    }
    this.deps.debug(`sendTextMessage: text length=${text.length}`);

    await sendMessageWeixin({
      to: creds.userId,
      text: text,
      opts: {
        baseUrl: creds.baseUrl,
        token: creds.token,
        contextToken: creds.contextToken,
      },
    });
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

    const creds = this.deps.getCredentials();
    if (!creds) {
      throw new Error("Single user not initialized");
    }

    const displayName = path.basename(localPath);
    this.deps.debug(
      `sendFileToUser START: localPath=${localPath}, displayName=${displayName} (使用官方 sendWeixinMediaFile)`,
    );

    const opts: WeixinApiOptions & { contextToken?: string } = {
      baseUrl: creds.baseUrl,
      token: creds.token,
      contextToken: creds.contextToken,
    };

    const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";

    // 直接调用官方高层函数（自动处理 upload + 正确构造 item）
    await sendWeixinMediaFile({
      filePath: localPath,
      to: creds.userId,
      text: "",
      opts,
      cdnBaseUrl,
    });

    this.deps.debug(
      `sendFileToUser COMPLETE: 文件 "${displayName}" 已通过官方 sendWeixinMediaFile 发送成功`,
    );
  }

  /**
   * 发送消息到微信（带重试）
   */
  async sendWithRetry(text: string, maxRetries: number = 3): Promise<void> {
    const creds = this.deps.getCredentials();
    if (!creds) {
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
