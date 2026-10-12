/**
 * session-ui.ts - 把 ExtensionContext 的 UI / console / qrcode-terminal 适配为 SessionUi
 *
 * 这是 `qrcode-terminal` 与 `console` 唯一允许出现的自写层文件（rf-2 依赖方向约束）：
 * `SessionService` 只依赖 `SessionUi` 窄接口，不感知终端实现。
 *
 * 二维码展示逻辑整体保持迁移前行为（`performWechatLogin` 原文）：
 * 成功用 qrcode-terminal 输出 + 浏览器链接兜底行；失败 notify + 纯链接行。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionUi } from "../application/session.js";

/** 把扩展事件/命令上下文适配为应用层 `SessionUi`。 */
export function createSessionUi(ctx: ExtensionContext): SessionUi {
  return {
    notify: (message, type) => ctx.ui.notify(message, type ?? "info"),
    log: (message) => console.log(message),
    showQr: (qrcodeUrl: string) => {
      try {
        const qrcodeTerminal = require("qrcode-terminal");
        qrcodeTerminal.generate(qrcodeUrl, { small: true }, (qr: string) => {
          console.log(qr);
        });
        console.log("如果二维码未能成功展示，请用浏览器打开以下链接扫码：");
        console.log(qrcodeUrl);
      } catch {
        ctx.ui.notify("Failed to display QR code in terminal", "error");
        console.log("请用浏览器打开以下链接扫码：");
        console.log(qrcodeUrl);
      }
    },
  };
}