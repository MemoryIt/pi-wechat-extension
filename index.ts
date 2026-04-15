/**
 * index.ts - 微信插件入口（单用户版本）
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveToken, upsertAccount, deleteToken, removeAccount, getDefaultAccountToken } from "./storage/state.js";
import { engine, setPi, setConfig } from "./wechat.js";
import { getPrefix, isDebugEnabled } from "./config.js";

// ============== 缓存 ==============

let cachedGitBranch: string | null = null;

// ============== 调试日志辅助函数 ==============

function debugLog(message: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(`[Wechat] ${message}`, ...args);
  }
}

export default function (pi: ExtensionAPI) {
  setPi(pi);

  // ============== 注册命令 ==============

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
          ctx.ui.notify(`WeChat: Logged in\nUser ID: ${token.userId}\nConnection: ${engine.connectionState}`, "info");
        } else {
          ctx.ui.notify("WeChat: Not logged in", "info");
        }
      } else if (subcommand === "start") {
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
        engine.stopPolling();
        const token = await getDefaultAccountToken();
        if (token) {
          await deleteToken(token.accountId);
          await removeAccount(token.accountId);
          ctx.ui.notify("WeChat: Logged out successfully", "info");
        } else {
          ctx.ui.notify("WeChat: Not logged in", "info");
        }
      } else {
        ctx.ui.notify("Usage: /wechat login | status | start | stop | logout", "info");
      }
    },
  });

  // ============== session_start ==============

  pi.on("session_start", async (_event, ctx) => {
    // 注册 footer 回调
    ctx.ui.setFooter((tui, theme, footerData) => {
      cachedGitBranch = footerData.getGitBranch();
      const unsub = footerData.onBranchChange(() => {
        cachedGitBranch = footerData.getGitBranch();
        tui.requestRender();
      });
      return {
        dispose: unsub,
        invalidate() {},
        render(_width: number): string[] {
          return [];
        },
      };
    });

    const token = await getDefaultAccountToken();
    if (token) {
      setConfig({ baseUrl: token.baseUrl, token: token.botToken });
      debugLog(`session_start: loaded token for userId=${token.userId}`);

      // 启动轮询
      engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken }).catch((err) => {
        console.error("[Wechat] Polling error:", err.message);
      });
    } else {
      debugLog(`session_start: no logged in account found`);
    }
  });

  // ============== session_shutdown ==============

  pi.on("session_shutdown", async () => {
    engine.stopPolling();
    engine.reset();
  });

  // ============== before_agent_start（简化）==============

  pi.on("before_agent_start", async (event, _ctx) => {
    // 简单检测是否是微信消息（通过前缀）
    const prefix = getPrefix();
    if (!event.prompt?.includes(prefix)) {
      return;
    }

    // 单用户模式下，直接从 engine 获取 requestId
    const requestId = engine.getCurrentRequestId();
    if (requestId) {
      debugLog(`before_agent_start: WeChat message detected, requestId=${requestId}`);
    }
  });

  // ============== message_start ==============

  pi.on("message_start", async (_event, _ctx) => {
    debugLog(`message_start: starting typing keepalive`);
    await engine.startTypingKeepalive();
  });

  // ============== message_end ==============

  pi.on("message_end", async (_event, _ctx) => {
    debugLog(`message_end: stopping typing keepalive`);
    await engine.stopTypingKeepalive();
  });

  // ============== agent_end ==============

  pi.on("agent_end", async (event, ctx) => {
    setTimeout(async () => {
      await handleAgentEnd(event, ctx);
    }, 20);
  });

  // ============== agent_end 处理函数 ==============

  async function handleAgentEnd(event: unknown, ctx: ExtensionContext) {
    const requestId = engine.getCurrentRequestId();

    if (!requestId) {
      // 不是微信触发的消息
      engine.onAiDone();
      return;
    }

    // 防重检查
    if (engine.isRequestProcessed(requestId)) {
      debugLog(`Request ${requestId} already processed, skipping`);
      return;
    }
    engine.markRequestProcessed(requestId);

    // 提取 AI 回复（最后一条有内容的 assistant 消息）
    const eventObj = event as { messages?: unknown[] };
    const assistantMessages = eventObj.messages?.filter?.((m: unknown) => {
      const msg = m as { role?: string };
      return msg.role === "assistant";
    }) ?? [];
    
    let replyText: string | null = null;
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      replyText = extractReplyText(assistantMessages[i]);
      if (replyText) break;
    }

    if (!replyText) {
      debugLog(`No reply text found`);
      engine.onAiDone();
      return;
    }

    debugLog(`Sending reply: ${replyText.slice(0, 50)}...`);

    // 追加模型元信息
    const metaInfo = buildMetaInfo(ctx);
    const finalReply = replyText + (metaInfo ? "\n\n" + metaInfo : "");

    // 发送回复
    try {
      await engine.sendMessageWithRetry(finalReply);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Wechat] Failed to send reply:`, errMsg);
      ctx.ui?.notify?.(`微信回复失败: ${errMsg}`, "error");
    }

    engine.onAiDone();
  }

  // ============== 辅助函数 ==============

  function extractReplyText(assistantMsg: unknown): string | null {
    const msg = assistantMsg as { content?: unknown };
    
    if (typeof msg.content === "string") {
      return msg.content.trim();
    }
    if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const block of msg.content) {
        const blockObj = block as { type?: string; text?: string };
        if (blockObj.type === "text") {
          texts.push(blockObj.text ?? "");
        }
      }
      return texts.join("\n").trim() || null;
    }
    if (typeof msg.content === "object" && msg.content !== null) {
      const contentObj = msg.content as { text?: string };
      if (contentObj.text) {
        return contentObj.text.trim();
      }
    }
    return null;
  }

  function buildMetaInfo(ctx: ExtensionContext): string {
    const lines: string[] = [];
    const cwd = ctx.cwd;
    const branchStr = cachedGitBranch ? ` (${cachedGitBranch})` : "";
    lines.push(`${cwd}${branchStr}`);

    const statsParts: string[] = [];

    const contextUsage = ctx.getContextUsage?.();
    if (contextUsage) {
      const { tokens, contextWindow, percent } = contextUsage;
      const percentStr = percent !== null ? `${percent.toFixed(1)}%` : "?%";
      const limitStr = `${(contextWindow / 1000).toFixed(0)}k`;
      statsParts.push(`${percentStr}/${limitStr}`);
    }

    let totalCost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      const entryObj = entry as { type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
      if (entryObj.type === "message" && entryObj.message?.role === "assistant") {
        totalCost += entryObj.message.usage?.cost?.total ?? 0;
      }
    }
    if (totalCost > 0) {
      statsParts.push(`$${totalCost.toFixed(3)}`);
    }

    if (ctx.model) {
      statsParts.push(`(${ctx.model.provider}) ${ctx.model.id}`);
    }

    if (statsParts.length > 0) {
      lines.push(statsParts.join(" "));
    }

    return lines.join("\n");
  }

  // ============== 登录处理 ==============

  async function handleLogin(ctx: ExtensionCommandContext) {
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

        console.log("\n=== 登录成功 ===");
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
}
