/**
 * index.ts - 微信插件入口（单用户版本）
 *
 * 事件桥接的核心约定：
 * - 不再使用模块级 `isCurrentMessageFromWechat` / `currentRequestId` + `setTimeout`
 *   的延迟读取；每轮 turn 的身份（`{ fromWechat, requestId }`）都在事件发生时
 *   通过 `resolveTurnBeforeRun()` / `resolveTurnFromBranch()` 从 session 中同步
 *   解析，并显式传给处理函数。
 * - 最终回复在 `agent_settled` 发送（一轮 prompt 只发一次，覆盖重试/压缩/续跑后的最终版）；
 *   `agent_end` 只负责 typing 收敛与终端标志兜底。
 */

import { Type, type Static } from "@sinclair/typebox";
import path from "node:path";
import { existsSync } from "node:fs";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveToken, upsertAccount, deleteAccountData, removeAccount, getDefaultAccountToken } from "./storage/state.js";
import { engine, setPi, setConfig } from "./wechat.js";
import { isDebugEnabled } from "./config.js";
import { redactToken } from "./util/redact.js";

// ============== 缓存 ==============

let cachedGitBranch: string | null = null;

interface WechatTurn {
  fromWechat: boolean;
  requestId: string | null;
}

/**
 * 由 `input` 事件（`pi.sendUserMessage` 注入）维护的待处理微信消息 FIFO。
 * 只用于在 `event.prompt` 兜底时识别来源，不保存跨轮的可变 turn 标记。
 */
const pendingWechatInputs: Array<{ requestId: string | null; text: string }> = [];

/**
 * buildMetaInfo 的增量成本累计：记录已处理的 entry id + 运行总量，
 * 使每轮只需处理新增分支（有界），而不是每轮全量扫描整个 branch。
 */
const costAccumulator = {
  processedIds: new Set<string>(),
  total: 0,
  lastIndex: 0,
  lastId: null as string | null,
};

// ============== 调试日志辅助函数 ==============

function debugLog(message: string, ...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(`[Wechat] ${message}`, ...args);
  }
}

export default function (pi: ExtensionAPI) {
  setPi(pi);

  // ============== 注册 Tool：允许 AI 发送文件 ==============
  const sendFileParams = Type.Object({
    localPath: Type.String({
      description: "必须填写：Pi 本地文件的**完整绝对路径**（例如 /Users/mou/code/pi-dev/Agent.pptx）",
    }),
  });

  const sendFileTool: ToolDefinition<typeof sendFileParams> = {
    name: "send_wechat_file",
    label: "Send WeChat file",
    description:
      "向当前微信用户发送本地文件。必须提供文件的**完整绝对路径**（如 /Users/mou/code/pi-dev/Agent.pptx）。" +
      "支持任意文件类型（pptx、pdf、jpg、png 等）。微信端将以该文件的本地文件名作为显示名。",
    parameters: sendFileParams,
    execute: async (
      toolCallId: string,
      params: Static<typeof sendFileParams>,
    ): Promise<AgentToolResult<unknown>> => {
      debugLog(`send_wechat_file tool called - toolCallId=${toolCallId}, params=`, JSON.stringify(params));

      if (!params || typeof params !== "object") {
        const errMsg = "工具调用参数错误：请提供 localPath 参数";
        debugLog(errMsg);
        throw new Error(errMsg);
      }

      const { localPath } = params;

      if (!localPath || typeof localPath !== "string" || localPath.trim() === "") {
        const errMsg = "必须提供 localPath 参数（文件的完整绝对路径）。例如：/Users/mou/code/pi-dev/Agent.pptx";
        debugLog(errMsg);
        throw new Error(errMsg);
      }

      const trimmedPath = localPath.trim();
      if (!existsSync(trimmedPath)) {
        const errMsg = `文件不存在: ${trimmedPath} （请确认路径是否正确，且文件在当前工作目录或指定绝对路径下）`;
        debugLog(errMsg);
        throw new Error(errMsg);
      }

      // 底层 sendFileToUser 不再支持自定义显示名，以本地文件名为准。
      const displayName = path.basename(trimmedPath);
      debugLog(`准备发送文件: ${displayName} (${trimmedPath})`);

      try {
        await engine.sendFileToUser(trimmedPath);
        const successMsg = `文件 "${displayName}" 已成功发送至微信`;
        debugLog(successMsg);
        return { content: [{ type: "text", text: successMsg }], details: {} };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`sendFileToUser 执行失败:`, errMsg);
        // SDK 约定：工具失败需通过 throw 上报（结果会带上 isError=true）。
        throw new Error(`发送文件失败: ${errMsg}`);
      }
    },
  };

  pi.registerTool(sendFileTool);

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
        // 与 session_start 保持一致：启动轮询前必须先把凭证同步给 engine。
        setConfig({ baseUrl: token.baseUrl, token: token.botToken });
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

  pi.on("session_start", async (_event, _ctx) => {
    // 不再用空 render 覆盖内置 footer；分支名通过 pi.exec 获取。
    cachedGitBranch = await readGitBranch();

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

  // ============== input ==============
  // pi.sendUserMessage 注入时 source === "extension"。把待处理微信消息文本入队，
  // 供 before_agent_start 在无法从 session 判断来源时用 event.prompt 兜底匹配。
  pi.on("input", (event, ctx) => {
    const inputEvent = event as { source?: string; text?: string };
    if (inputEvent.source !== "extension") return { action: "continue" };

    const turn = resolveTurnBeforeRun(ctx);
    if (turn.fromWechat) {
      pendingWechatInputs.push({ requestId: turn.requestId, text: inputEvent.text ?? "" });
    }
    return { action: "continue" };
  });

  // ============== before_agent_start ==============

  pi.on("before_agent_start", async (event, ctx) => {
    // 同步捕获本轮 turn 的身份，不做任何延迟。
    // 此刻当前 user 消息尚未写入分支（pi 在 before_agent_start 之后才 append），
    // 因此用「最近一条 wechat_meta 是否位于最后一条 assistant 之后」判断。
    const turn = resolveTurnBeforeRun(ctx, (event as { prompt?: string }).prompt);
    if (turn.fromWechat) {
      debugLog(`before_agent_start: WeChat turn detected, requestId=${turn.requestId ?? "(unknown)"}`);
    } else {
      // 终端消息正在处理，微信消息需要排队
      engine.setTerminalProcessing(true);
      debugLog(`before_agent_start: Terminal turn, WeChat messages will be queued`);
    }
  });

  // ============== message_start / message_end（typing）==============
  // 只在 assistant 消息上开启 / 停止 typing；user / toolResult 的结束不得提前关闭。

  pi.on("message_start", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    debugLog(`message_start: starting typing keepalive`);
    await engine.startTypingKeepalive();
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isAssistantMessage(event)) return;
    if (!resolveTurnFromBranch(ctx).fromWechat) return;
    debugLog(`message_end: stopping typing keepalive`);
    await engine.stopTypingKeepalive();
  });

  // ============== agent_end ==============
  // 只用于 typing 收敛（以及终端标志兜底），最终回复统一在 agent_settled 发送。

  pi.on("agent_end", async (_event, ctx) => {
    const turn = resolveTurnFromBranch(ctx);
    if (turn.fromWechat) {
      await engine.stopTypingKeepalive();
    } else {
      engine.setTerminalProcessing(false);
    }
  });

  // ============== agent_settled ==============

  pi.on("agent_settled", async (_event, ctx) => {
    // 每轮结束时的可靠信号：pi 不会再有自动重试 / 压缩 / 续跑。
    const turn = resolveTurnFromBranch(ctx);

    if (!turn.fromWechat) {
      // 终端 turn：释放标志并排空队列（对缺失 agent_end 的情况也是兜底）。
      engine.setTerminalProcessing(false);
      engine.onAiDone();
      return;
    }

    await handleWechatSettled(ctx, turn);
  });

  // ============== agent_settled 处理函数 ==============

  async function handleWechatSettled(ctx: ExtensionContext, turn: WechatTurn): Promise<void> {
    try {
      if (!turn.requestId) {
        debugLog(`agent_settled: WeChat turn without requestId, skip sending`);
        return;
      }

      // 防重
      if (engine.isRequestProcessed(turn.requestId)) {
        debugLog(`Request ${turn.requestId} already processed, skipping`);
        return;
      }

      // 提取本轮最终回复（branch 中最后一条有文本的 assistant 消息）
      const replyText = extractLastReply(ctx);
      if (!replyText) {
        debugLog(`agent_settled: no reply text found`);
        return;
      }

      // typing 兜底停止
      await engine.stopTypingKeepalive();

      // 追加模型元信息
      const metaInfo = buildMetaInfo(ctx);
      const finalReply = replyText + (metaInfo ? "\n\n" + metaInfo : "");

      debugLog(`Sending reply: ${replyText.slice(0, 50)}...`);

      try {
        await engine.sendMessageWithRetry(finalReply);
        // 只有发送成功后才标记已处理，失败时仍可重试（D2）。
        engine.markRequestProcessed(turn.requestId);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Wechat] Failed to send reply:`, errMsg);
        ctx.ui?.notify?.(`微信回复失败: ${errMsg}`, "error");
      }
    } finally {
      // 所有早退 / 异常路径都必须释放队列，否则后续微信消息会永久停滞（D1）。
      engine.onAiDone();
    }
  }

  // ============== 辅助函数 ==============

  /** 统一的分支 entry 视图（fake / 真实 SessionEntry 的公共子集）。 */
  interface BranchEntry {
    type?: string;
    id?: string;
    parentId?: string | null;
    customType?: string;
    data?: { requestId?: string };
    message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } } };
  }

  function getBranch(ctx: ExtensionContext): BranchEntry[] {
    return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
  }

  function isAssistantMessage(event: unknown): boolean {
    return (event as { message?: { role?: string } })?.message?.role === "assistant";
  }

  /**
   * 事件发生时同步解析 turn 身份（pre-run）：优先用 session 中的 wechat_meta，
   * 找不到时用 event.prompt 与 input FIFO 兜底。
   */
  function resolveTurnBeforeRun(ctx: ExtensionContext, prompt?: string): WechatTurn {
    const meta = resolvePendingWechatMeta(ctx);
    if (meta) return { fromWechat: true, requestId: meta.requestId };

    if (typeof prompt === "string") {
      const idx = pendingWechatInputs.findIndex((item) => item.text === prompt);
      if (idx >= 0) {
        const [item] = pendingWechatInputs.splice(idx, 1);
        return { fromWechat: true, requestId: item.requestId };
      }
    }

    return { fromWechat: false, requestId: null };
  }

  /**
   * pre-run（before_agent_start / input）阶段：当前 user 消息尚未写入分支，
   * 因此从叶子向前扫描，遇到 wechat_meta 即为微信 turn；
   * 先遇到 assistant 说明上一轮已结束，属终端 turn。
   */
  function resolvePendingWechatMeta(ctx: ExtensionContext): { requestId: string | null } | null {
    const branch = getBranch(ctx);
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === "wechat_meta") {
        return { requestId: entry.data?.requestId ?? null };
      }
      if (entry.type === "message" && entry.message?.role === "assistant") {
        return null;
      }
    }
    return null;
  }

  function resolveTurnFromBranch(ctx: ExtensionContext): WechatTurn {
    const meta = resolveActiveWechatMeta(ctx);
    return { fromWechat: meta !== null, requestId: meta?.requestId ?? null };
  }

  /**
   * 运行中 / 结束后：当前 user 消息已经在分支里，用它的 parentId 反向关联 wechat_meta。
   * 若还没有 user 消息（测试夹具 / 边界情况），退化为 pre-run 规则。
   */
  function resolveActiveWechatMeta(ctx: ExtensionContext): { requestId: string | null } | null {
    const branch = getBranch(ctx);

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];

      if (entry.type === "message" && entry.message?.role === "user") {
        const parentId = entry.parentId;
        if (parentId) {
          const parent = ctx.sessionManager.getEntry(parentId) as
            | { type?: string; customType?: string; data?: { requestId?: string } }
            | undefined;
          if (parent?.type === "custom" && parent.customType === "wechat_meta") {
            return { requestId: parent.data?.requestId ?? null };
          }
        }
        return null;
      }

      if (entry.type === "custom" && entry.customType === "wechat_meta") {
        return { requestId: entry.data?.requestId ?? null };
      }
    }

    return null;
  }

  /** 提取 branch 中最后一条有文本的 assistant 回复。 */
  function extractLastReply(ctx: ExtensionContext): string | null {
    const branch = getBranch(ctx);
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const text = extractReplyText(entry.message);
        if (text) return text;
      }
    }
    return null;
  }

  function extractReplyText(assistantMsg: unknown): string | null {
    const msg = assistantMsg as { content?: unknown };

    if (typeof msg.content === "string") {
      return msg.content.trim() || null;
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

    const totalCost = accumulateCost(ctx);
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

  /**
   * 增量累计分支中的 assistant 成本。
   * 记录已处理 entry id + 运行总量，并在分支连续增长时只处理新增部分；
   * 分支发生压缩 / 分叉时回退为按 id 去重的扫描，保证不重复累计。
   */
  function accumulateCost(ctx: ExtensionContext): number {
    const branch = getBranch(ctx);

    let start = 0;
    if (
      costAccumulator.lastId !== null &&
      costAccumulator.lastIndex > 0 &&
      costAccumulator.lastIndex <= branch.length
    ) {
      const anchor = branch[costAccumulator.lastIndex - 1];
      if (anchor && anchor.id === costAccumulator.lastId) {
        start = costAccumulator.lastIndex;
      }
    }

    for (let i = start; i < branch.length; i++) {
      const entry = branch[i];
      const id = entry.id;
      if (id && costAccumulator.processedIds.has(id)) continue;

      if (entry.type === "message" && entry.message?.role === "assistant") {
        costAccumulator.total += entry.message.usage?.cost?.total ?? 0;
      }
      if (id) costAccumulator.processedIds.add(id);
    }

    costAccumulator.lastIndex = branch.length;
    costAccumulator.lastId = branch.length > 0 ? branch[branch.length - 1].id ?? null : null;

    return costAccumulator.total;
  }

  // ============== 登录处理 ==============

  async function readGitBranch(): Promise<string | null> {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"]);
      const branch = (result?.stdout ?? "").trim();
      return branch || null;
    } catch {
      return null;
    }
  }

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
      ctx.ui.notify(`登录异常: ${String(err)}`, "error");
    }
  }
}
