/**
 * commands.ts - /wechat 命令注册
 *
 * 从 index.ts 拆出：注册 `/wechat` 命令并处理 login / status / start / stop / logout。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDefaultAccountToken, deleteAccountData, removeAccount } from "./storage/state.js";
import { setConfig } from "./wechat.js";
import type { WechatEngine } from "./wechat.js";
import { performWechatLogin } from "./login.js";

export function registerCommands(pi: ExtensionAPI, engine: WechatEngine): void {
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
        await performWechatLogin(ctx, engine);
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
}
