/**
 * commands.ts - /wechat 命令注册与子命令分发
 *
 * 只保留 pi 命令注册、补全与子命令分发；具体操作全部委托 `SessionService`
 * （会话生命周期单一入口，见 `src/application/session.ts`）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionService } from "../application/session.js";
import { createSessionUi } from "./session-ui.js";

export function registerCommands(pi: ExtensionAPI, session: SessionService): void {
  pi.registerCommand("wechat", {
    description: "WeChat integration",
    getArgumentCompletions: (prefix) => {
      const commands = ["login", "status", "start", "stop", "logout"];
      const filtered = commands.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const ui = createSessionUi(ctx);
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "login") {
        await session.login(ui);
      } else if (subcommand === "status") {
        await session.status(ui);
      } else if (subcommand === "start") {
        await session.start(ui);
      } else if (subcommand === "stop") {
        session.stop(ui);
      } else if (subcommand === "logout") {
        await session.logout(ui);
      } else {
        ui.notify("Usage: /wechat login | status | start | stop | logout", "info");
      }
    },
  });
}