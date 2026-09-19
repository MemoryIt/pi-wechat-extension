/**
 * login.ts - 微信扫码登录
 *
 * 从 index.ts 拆出：`performWechatLogin()` 负责生成二维码、等待扫码、
 * 持久化凭证并启动轮询。
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "../auth/login-qr.js";
import { saveToken, upsertAccount } from "./storage/state.js";
import { setConfig } from "./wechat.js";
import type { WechatEngine } from "./wechat.js";
import { redactToken } from "../util/redact.js";
import { isDebugEnabled } from "./config.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ isDebugEnabled: () => isDebugEnabled() });

export async function performWechatLogin(ctx: ExtensionCommandContext, engine: WechatEngine): Promise<void> {
  try {
    const startResult = await startWeixinLoginWithQr({
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
      botType: DEFAULT_ILINK_BOT_TYPE,
      verbose: true,
    });

    if (!startResult.qrcodeUrl) {
      ctx.ui.notify(`Failed to get QR code: ${startResult.message}`, "error");
      return;
    }

    ctx.ui.notify("请使用微信扫描二维码...", "info");

    try {
      const qrcodeTerminal = require("qrcode-terminal");
      qrcodeTerminal.generate(startResult.qrcodeUrl, { small: true }, (qr: string) => {
        console.log(qr);
      });
      console.log("如果二维码未能成功展示，请用浏览器打开以下链接扫码：");
      console.log(startResult.qrcodeUrl);
    } catch {
      ctx.ui.notify("Failed to display QR code in terminal", "error");
      console.log("请用浏览器打开以下链接扫码：");
      console.log(startResult.qrcodeUrl);
    }

    const loginResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
      timeoutMs: 480_000,
      verbose: true,
      botType: DEFAULT_ILINK_BOT_TYPE,
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

      ctx.ui.notify("✅ 与微信连接成功！", "info");

      setConfig({ baseUrl: loginResult.baseUrl!, token: botToken });

      // 登录成功后自动启动轮询
      engine.startPolling({ baseUrl: loginResult.baseUrl!, token: botToken }).catch((err) => {
        ctx.ui.notify(`启动轮询失败: ${err.message}`, "error");
      });

      // 不打印明文凭证，仅输出脱敏后的字段（D11）。
      console.log("\n=== 登录成功 ===");
      console.log(
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
      console.log("================\n");
    } else {
      ctx.ui.notify(`登录失败: ${loginResult.message}`, "error");
    }
  } catch (err) {
    logger.debug("performWechatLogin failed:", err);
    ctx.ui.notify(`登录异常: ${String(err)}`, "error");
  }
}
