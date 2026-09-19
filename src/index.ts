/**
 * index.ts - 微信插件入口（组合根，单用户版本）
 *
 * 只负责把各聚焦模块装配到 pi：
 * - `wechat.ts` 提供 engine 单例与 setPi；
 * - `tool-send-file.ts` 注册发送文件工具；
 * - `commands.ts` 注册 /wechat 命令；
 * - `bridge.ts` 注册事件桥接（turn / meta 逻辑分别位于 turn.ts / meta.ts）。
 *
 * 事件桥接的核心约定见 bridge.ts。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { engine, setPi } from "./wechat.js";
import { createSendFileTool } from "./tool-send-file.js";
import { registerCommands } from "./commands.js";
import { registerBridge } from "./bridge.js";

export default function (pi: ExtensionAPI) {
  setPi(pi);

  pi.registerTool(createSendFileTool(engine));
  registerCommands(pi, engine);
  registerBridge(pi, engine);
}
