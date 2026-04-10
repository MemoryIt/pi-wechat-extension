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
import { engine, setPi, setConfig } from "./wechat.js";

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
      setConfig({ baseUrl: token.baseUrl, token: token.botToken });
      engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken }).catch((err) => {
        console.error("[Wechat] Polling error:", err.message);
      });
    }
  });

  // === session_shutdown: 停止轮询 ===
  pi.on("session_shutdown", async () => {
    engine.stopPolling();
    engine.reset();
  });

  // === before_agent_start: 识别 WeChat 触发 + 发送 typing=1 ===
  pi.on("before_agent_start", async (event, ctx) => {
    // 通过 prompt 正则判断是否是 WeChat 消息
    const requestIdMatch = event.prompt?.match(/__WECHAT_REQ_([a-z0-9]+)__/);
    const userMatch = event.prompt?.match(/\[WeChat; ([^\]]+)\]/);

    // 不是 WeChat 消息，跳过
    if (!userMatch) return;

    const displayName = userMatch[1];
    const requestId = requestIdMatch?.[1] ?? null;

    // 通过 displayName 查找用户上下文
    let userCtx = null;
    for (const ctx of engine.getUserContexts().values()) {
      if (ctx.displayName === displayName || ctx.userId === displayName) {
        userCtx = ctx;
        break;
      }
    }

    if (!userCtx) {
      console.log(`[Wechat] UserContext not found for displayName: ${displayName}`);
      return;
    }

    // 保存当前用户和 requestId（闭包变量，供 turn_end 和 agent_end 使用）
    engine.setCurrentRequest(requestId, userCtx.userId);

    // 发送 typing=1 (TYPING)
    await engine.sendTypingStatus(userCtx.userId, userCtx.contextToken, 1);

    console.log(`[Wechat] before_agent_start: displayName=${displayName}, requestId=${requestId}`);
  });

  // === turn_end: 取消 typing ===
  pi.on("turn_end", async (event, ctx) => {
    const userId = engine.getCurrentUserId();
    if (!userId) return;

    const userCtx = engine.getUserContexts().get(userId);
    if (!userCtx) return;

    // 发送 typing=2 (CANCEL)
    await engine.sendTypingStatus(userId, userCtx.contextToken, 2);
  });

  // === agent_end: AI 回复完成后发送回微信 ===
  // 使用 setTimeout(20) 避免 agent_end 时序问题（见 issue #2110, #2860）
  pi.on("agent_end", async (event, ctx) => {
    setTimeout(async () => {
      await handleAgentEnd(event, ctx);
    }, 20);
  });

  // === agent_end 处理函数 ===
  async function handleAgentEnd(event: any, ctx: any) {
    // 获取 requestId 和 userId：优先用闭包
    const requestId = engine.getCurrentRequestId();
    let userId = engine.getCurrentUserId();

    if (!requestId || !userId) {
      // 尝试从 session entries 中查找
      try {
        const entries = ctx.sessionManager?.getBranch?.() ?? [];
        const wechatMeta = entries
          .filter((e: any) => e.type === "custom" && e.customType === "wechat_meta")
          .reverse()
          .find((e: any) => e.data?.requestId === requestId);
        userId = wechatMeta?.data?.userId ?? null;
      } catch (e) {
        // ignore
      }
    }

    if (!requestId || !userId) {
      // 不是微信触发的 AI 回复，直接处理队列
      engine.onAiDone();
      return;
    }

    // 防止重复处理
    if (engine.isRequestProcessed(requestId)) {
      console.log(`[Wechat] Request ${requestId} already processed, skipping`);
      return;
    }
    engine.markRequestProcessed(requestId);

    // 获取用户上下文
    const userCtx = engine.getUserContexts().get(userId ?? "");
    
    // 详细日志帮助诊断
    console.log(`[Wechat] handleAgentEnd: requestId=${requestId}, userId=${userId}`);
    console.log(`[Wechat] userContexts keys: ${JSON.stringify(Array.from(engine.getUserContexts().keys()))}`);
    console.log(`[Wechat] userCtx: ${JSON.stringify(userCtx)}`);
    
    if (!userCtx) {
      console.error(`[Wechat] UserContext not found for userId: ${userId}`);
      console.error(`[Wechat] This means we don't have a contextToken for this user.`);
      console.error(`[Wechat] The message may have arrived without a context_token.`);
      console.error(`[Wechat] Skipping send and processing queue anyway.`);
      engine.onAiDone();
      return;
    }

    // 提取 AI 回复
    const assistantMsg = event.messages?.find?.((m: any) => m.role === "assistant");
    if (!assistantMsg) {
      console.log(`[Wechat] No assistant message found`);
      engine.onAiDone();
      return;
    }

    // 提取回复文本
    const replyText = extractReplyText(assistantMsg);
    if (!replyText) {
      console.log(`[Wechat] No reply text extracted`);
      engine.onAiDone();
      return;
    }

    console.log(`[Wechat] Sending reply to user ${userId} with contextToken ${userCtx.contextToken ? 'present' : 'MISSING'}: ${replyText.slice(0, 50)}...`);

    // 发送回微信（带重试）
    try {
      await engine.sendMessageWithRetry(userId, userCtx.contextToken, replyText);
    } catch (err: any) {
      console.error(`[Wechat] Failed to send reply:`, err.message);
      ctx.ui?.notify?.(`微信回复失败: ${err.message}`, "error");
    }

    // 处理队列中的下一条消息
    engine.onAiDone();
  }

  // === 辅助函数：从 assistant 消息中提取回复文本 ===
  function extractReplyText(assistantMsg: any): string | null {
    // 支持多种格式
    if (typeof assistantMsg.content === "string") {
      return assistantMsg.content.trim();
    }

    if (Array.isArray(assistantMsg.content)) {
      // content 是数组，取所有文本部分
      const texts: string[] = [];
      for (const block of assistantMsg.content) {
        if (block.type === "text") {
          texts.push(block.text ?? "");
        }
      }
      return texts.join("\n").trim() || null;
    }

    if (assistantMsg.content?.text) {
      return assistantMsg.content.text.trim();
    }

    return null;
  }
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

      // 保存配置供 sendTyping 和 sendMessage 使用
      setConfig({ baseUrl: loginResult.baseUrl!, token: botToken });

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
