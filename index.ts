/**
 * index.ts - 微信插件入口（单用户版本）
 */

import { Type } from "@sinclair/typebox";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveToken, upsertAccount, deleteToken, deleteAccountData, removeAccount, getDefaultAccountToken } from "./storage/state.js";
import { engine, setPi, setConfig } from "./wechat.js";
import { isDebugEnabled } from "./config.js";

// ============== 缓存 ==============

let cachedGitBranch: string | null = null;

// 标识当前消息是否来自微信（默认 false）
let isCurrentMessageFromWechat = false;

// 保存当前消息的 requestId
let currentRequestId: string | null = null;

// ============== 调试日志辅助函数 ==============

function debugLog(message: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(`[Wechat] ${message}`, ...args);
  }
}

export default function (pi: ExtensionAPI) {
  setPi(pi);

  // ============== 注册命令 ==============

  // ============== 注册 Tool：允许 AI 发送文件 ==============
  pi.registerTool({
    name: "send_wechat_file",
    description: "向当前微信用户发送本地文件。必须提供文件的**完整绝对路径**（如 /Users/mou/code/pi-dev/Agent.pptx）。支持任意文件类型（pptx、pdf、jpg、png 等）。",
    parameters: Type.Object({
      localPath: Type.String({
        description: "必须填写：Pi 本地文件的**完整绝对路径**（例如 /Users/mou/code/pi-dev/Agent.pptx）",
      }),
      fileName: Type.Optional(Type.String({
        description: "可选：发送时在微信中显示的文件名（默认使用实际文件名）",
      })),
    }),
    execute: async (toolCallId: string, params: unknown, signal?: unknown, onUpdate?: unknown) => {
      debugLog(`send_wechat_file tool called - toolCallId=${toolCallId}, params=`, JSON.stringify(params));

      if (!params || typeof params !== "object") {
        const errMsg = "工具调用参数错误：请提供 localPath 参数";
        debugLog(errMsg);
        return { content: [{ type: "text", text: errMsg }], isError: true };
      }

      const { localPath, fileName } = params as { localPath?: string; fileName?: string };

      if (!localPath || typeof localPath !== "string" || localPath.trim() === "") {
        const errMsg = "必须提供 localPath 参数（文件的完整绝对路径）。例如：/Users/mou/code/pi-dev/Agent.pptx";
        debugLog(errMsg);
        return { content: [{ type: "text", text: errMsg }], isError: true };
      }

      const trimmedPath = localPath.trim();
      if (!existsSync(trimmedPath)) {
        const errMsg = `文件不存在: ${trimmedPath} （请确认路径是否正确，且文件在当前工作目录或指定绝对路径下）`;
        debugLog(errMsg);
        return { content: [{ type: "text", text: errMsg }], isError: true };
      }

      const displayName = fileName && typeof fileName === "string" && fileName.trim() !== ""
        ? fileName.trim()
        : path.basename(trimmedPath);

      debugLog(`准备发送文件: ${displayName} (${trimmedPath})`);

      try {
        await engine.sendFileToUser(trimmedPath, displayName);
        const successMsg = `文件 "${displayName}" 已成功发送至微信`;
        debugLog(successMsg);
        return { content: [{ type: "text", text: successMsg }] };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`sendFileToUser 执行失败:`, errMsg);
        return { content: [{ type: "text", text: `发送文件失败: ${errMsg}` }], isError: true };
      }
    },
  });

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
        engine.reset();
        const token = await getDefaultAccountToken();
        if (token) {
          await deleteAccountData(token.accountId);
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

  // ============== before_agent_start ==============

  pi.on("before_agent_start", async (_event, ctx) => {
    // 标识当前消息是否来自微信
    const wechatMeta = findWechatMetaFromSession(ctx);
    isCurrentMessageFromWechat = !!wechatMeta;
    currentRequestId = wechatMeta?.requestId ?? null;

    if (wechatMeta) {
      debugLog(`before_agent_start: WeChat message detected, requestId=${wechatMeta.requestId}`);
    } else {
      // 终端消息正在处理，微信消息需要排队
      engine.setTerminalProcessing(true);
      debugLog(`before_agent_start: Terminal message processing, WeChat messages will be queued`);
    }
  });

  // ============== message_start ==============

  pi.on("message_start", async (_event, _ctx) => {
    if (isCurrentMessageFromWechat) {
      debugLog(`message_start: starting typing keepalive`);
      await engine.startTypingKeepalive();
    }
  });

  // ============== message_end ==============

  pi.on("message_end", async (_event, _ctx) => {
    if (isCurrentMessageFromWechat) {
      debugLog(`message_end: stopping typing keepalive`);
      await engine.stopTypingKeepalive();
    }
  });

  // ============== agent_end ==============

  pi.on("agent_end", async (event, ctx) => {
    // 如果是终端消息处理结束，重置终端处理状态
    if (!isCurrentMessageFromWechat) {
      engine.setTerminalProcessing(false);
    }

    setTimeout(async () => {
      await handleAgentEnd(event, ctx);
    }, 20);
  });

  // ============== agent_end 处理函数 ==============

  async function handleAgentEnd(event: unknown, ctx: ExtensionContext) {
    const eventObj = event as { messages?: unknown[] };

    if (!isCurrentMessageFromWechat) {
      // 终端消息，不发送微信
      // 注意：isTerminalMessageProcessing 已在 agent_end 事件中重置
      // onAiDone 会触发队列处理
      engine.onAiDone();
      return;
    }

    // 使用 before_agent_start 时保存的 requestId
    const requestId = currentRequestId;
    if (!requestId) {
      debugLog(`No requestId found`);
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

  /**
   * 从 sessionManager 中查找 wechat_meta
   * 只检查最后一个 entry（最近添加的），因为 wechat_meta 在 sendUserMessage 之前写入
   */
  function findWechatMetaFromSession(ctx: ExtensionContext): { requestId: string } | null {
    const entries = ctx.sessionManager.getBranch();
    
    if (entries.length === 0) return null;
    
    // 只检查最后一个 entry（最近添加的）
    const lastEntry = entries[entries.length - 1] as { type?: string; customType?: string; data?: unknown };
    
    // 检查最后一个 entry 是否是 wechat_meta
    if (lastEntry.type === "custom" && lastEntry.customType === "wechat_meta") {
      return lastEntry.data as { requestId: string };
    }
    
    // 最后一个 entry 不是 wechat_meta，说明不是微信消息
    return null;
  }

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
