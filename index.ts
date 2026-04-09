/**
 * pi-wechat-extension
 * 
 * WeChat integration for pi coding agent
 * 
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /wechat login to scan the QR code
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveToken, upsertAccount, getDefaultAccountToken, deleteToken, removeAccount, listAccounts } from "./storage/state.js";
import { engine, setPi } from "./wechat.js";

export default function (pi: ExtensionAPI) {
  // 注入 pi 实例到 wechat engine
  setPi(pi);

  // 注册 wechat login command
  pi.registerCommand("wechat", {
    description: "WeChat integration",
    getArgumentCompletions: (prefix) => {
      const commands = ["login", "status", "start", "stop", "logout"];
      const filtered = commands.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();
      
      if (subcommand === "login") {
        await handleLogin(ctx);
      } else if (subcommand === "status") {
        const token = await getDefaultAccountToken();
        if (token) {
          ctx.ui.notify(`WeChat: Logged in (${token.accountId})
Connection State: ${engine.connectionState}`, "info");
        } else {
          ctx.ui.notify("WeChat: Not logged in", "info");
        }
      } else if (subcommand === "start") {
        // 手动启动轮询（用于测试）
        const token = await getDefaultAccountToken();
        if (!token) {
          ctx.ui.notify("WeChat: Not logged in. Use /wechat login first.", "error");
          return;
        }
        ctx.ui.notify("WeChat: Starting polling...", "info");
        engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken }).catch((err) => {
          ctx.ui.notify(`Polling error: ${err.message}`, "error");
        });
      } else if (subcommand === "stop") {
        engine.stopPolling();
        ctx.ui.notify("WeChat: Stopped polling", "info");
      } else if (subcommand === "logout") {
        // 停止轮询
        engine.stopPolling();
        // 获取当前账号并删除
        const token = await getDefaultAccountToken();
        if (token) {
          await deleteToken(token.accountId);
          await removeAccount(token.accountId);
          ctx.ui.notify("WeChat: Logged out successfully", "info");
        } else {
          ctx.ui.notify("WeChat: Not logged in", "info");
        }
      } else {
        ctx.ui.notify("Usage: /wechat login | status | start | stop", "info");
      }
    },
  });

  // === session_start: 启动长轮询 ===
  pi.on("session_start", async () => {
    const token = await getDefaultAccountToken();
    if (token) {
      console.log("[Wechat] Starting polling after session_start...");
      engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken }).catch((err) => {
        console.error("[Wechat] Polling error:", err.message);
      });
    }
  });

  // === session_shutdown: 停止轮询 ===
  pi.on("session_shutdown", async () => {
    console.log("[Wechat] Stopping polling after session_shutdown...");
    engine.stopPolling();
  });

  // === agent_end: AI 回复完成后处理队列 ===
  // 注意：直接调用 sendUserMessage 有时序问题，使用 setTimeout 延迟
  pi.on("agent_end", async () => {
    console.log("[Wechat] AI processing done, scheduling onAiDone()...");
    setTimeout(() => {
      console.log("[Wechat] Calling onAiDone() after delay...");
      engine.onAiDone();
    }, 10);
  });
}

async function handleLogin(ctx: ExtensionCommandContext) {
  try {
    // Step 1: Get QR code
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

    // Display QR code using qrcode-terminal
    try {
      // qrcode-terminal is a CommonJS module, use require() for compatibility
      const qrcodeTerminal = require("qrcode-terminal");
      qrcodeTerminal.generate(startResult.qrcodeUrl, { small: true }, (qr: string) => {
        console.log(qr);
      });
      console.log("如果二维码未能成功展示，请用浏览器打开以下链接扫码：");
      console.log(startResult.qrcodeUrl);
    } catch (err) {
      ctx.ui.notify("Failed to display QR code in terminal", "error");
      console.log("请用浏览器打开以下链接扫码：");
      console.log(startResult.qrcodeUrl);
    }

    // Step 2: Wait for login
    const loginResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
      timeoutMs: 480_000, // 8 minutes
      verbose: true,
      botType: DEFAULT_ILINK_BOT_TYPE,
    });

    if (loginResult.connected) {
      const accountId = loginResult.accountId!;
      const botToken = loginResult.botToken!;

      // 保存登录凭证
      await saveToken(accountId, {
        botToken,
        accountId,
        userId: loginResult.userId!,
        baseUrl: loginResult.baseUrl!,
        loginAt: Date.now(),
      });

      // 保存账号索引
      await upsertAccount({
        accountId,
        displayName: "微信账号",
        loginAt: Date.now(),
      });

      ctx.ui.notify("✅ 与微信连接成功！", "info");

      // 登录成功后自动启动轮询
      engine.startPolling({ baseUrl: loginResult.baseUrl!, token: botToken }).catch((err) => {
        ctx.ui.notify(`启动轮询失败: ${err.message}`, "error");
      });

      // Output server response
      console.log("\n=== 登录成功 ===");
      console.log("服务器返回信息：");
      console.log(JSON.stringify({
        botToken,
        accountId,
        userId: loginResult.userId,
        baseUrl: loginResult.baseUrl,
      }, null, 2));
      console.log("================\n");
    } else {
      ctx.ui.notify(`登录失败: ${loginResult.message}`, "error");
    }
  } catch (err) {
    ctx.ui.notify(`登录异常: ${String(err)}`, "error");
  }
}
