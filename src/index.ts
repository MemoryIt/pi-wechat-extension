/**
 * index.ts - 微信插件入口（组合根，单用户版本）
 *
 * 显式组装依赖并注入 bridge：
 * - `Channel` 负责通道编排；本文件把所有公共成员经注入传给 bridge；
 * - `WechatAuth` 负责扫码登录；
 * - `tool-send-file.ts` 注册发送文件工具；
 * - `commands.ts` 注册 /wechat 命令；
 * - `bridge/events.ts` 注册事件桥接（turn / meta 逻辑分别位于 turn.ts / meta.ts）。
 *
 * `createExtension(deps?)` 支持测试注入 fake `Channel` / `WechatAuth`；
 * 默认导出的实例每次调用都会创建独立的 `Channel`，互不共享状态。
 * 事件桥接的核心约定见 bridge/events.ts。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Channel } from "./channel/channel.js";
import type { WechatAuth } from "./ports/auth.js";
import type { PiHost } from "./ports/pi-host.js";
import { createWechatAuth } from "./adapters/auth.js";
import { createSendFileTool } from "./bridge/tool-send-file.js";
import { registerCommands } from "./bridge/commands.js";
import { registerBridge } from "./bridge/events.js";

/** 组合根可注入依赖（测试用 fake；生产缺省时创建真实实现）。 */
export interface ExtensionDeps {
  channel?: Channel;
  auth?: WechatAuth;
}

/** 把完整 ExtensionAPI 适配为窄接口 PiHost。 */
function piToHost(pi: ExtensionAPI): PiHost {
  return {
    appendEntry: (type, data) => pi.appendEntry(type, data),
    sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
    sendMessage: (message, options) => pi.sendMessage(message, options),
  };
}

export function createExtension(deps: ExtensionDeps = {}) {
  return (pi: ExtensionAPI) => {
    const channel = deps.channel ?? new Channel();
    channel.setHost(piToHost(pi));

    const auth = deps.auth ?? createWechatAuth();

    pi.registerTool(createSendFileTool(channel));
    registerCommands(pi, channel, auth);
    registerBridge(pi, channel);
  };
}

export default createExtension();
