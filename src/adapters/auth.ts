/**
 * ACL: src/adapters/auth.ts — 二维码登录的 Anti-Corruption Layer
 *
 * 本文件是自写层唯一接触 vendor `auth/login-qr` 的地方。
 * 翻译：vendor 两步登录包装为端口两步 ——
 *       startWeixinLoginWithQr → startQr；waitForWeixinLogin → waitForLogin。
 *       `botType` 缺省时采用 vendor 的 `DEFAULT_ILINK_BOT_TYPE`（adapter 内吸收默认值）。
 * 有意隐藏/丢弃：vendor 的详细错误 / 网络重试 / 日志细节不外泄，端口只暴露
 *       qrcodeUrl/message/sessionKey 与 connected/botToken/accountId/baseUrl/userId。
 * 边界纪律：vendor 类型、vendor 路径、全局状态不得泄漏回上层；
 *       上层只依赖 `src/ports/auth.ts` 的端口类型。
 */
/**
 * auth.ts - 二维码登录 adapter（WechatAuth）
 *
 * 薄包装 vendor 的 `auth/login-qr` 两步登录：
 *   startWeixinLoginWithQr → startQr
 *   waitForWeixinLogin     → waitForLogin
 * 字段与端口 WechatAuth 对齐；botType 缺省时采用 DEFAULT_ILINK_BOT_TYPE。
 */

import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_ILINK_BOT_TYPE,
} from "../../auth/login-qr.js";
import type {
  WechatAuth,
  WechatAuthStartQrOpts,
  WechatAuthStartQrResult,
  WechatAuthWaitForLoginOpts,
  WechatAuthWaitForLoginResult,
} from "../ports/auth.js";

export function createWechatAuth(): WechatAuth {
  return {
    async startQr(opts: WechatAuthStartQrOpts): Promise<WechatAuthStartQrResult> {
      const result = await startWeixinLoginWithQr({
        apiBaseUrl: opts.apiBaseUrl,
        accountId: opts.accountId,
        botType: opts.botType ?? DEFAULT_ILINK_BOT_TYPE,
        force: opts.force,
        timeoutMs: opts.timeoutMs,
        verbose: opts.verbose,
      });
      return {
        qrcodeUrl: result.qrcodeUrl,
        message: result.message,
        sessionKey: result.sessionKey,
      };
    },

    async waitForLogin(
      opts: WechatAuthWaitForLoginOpts,
    ): Promise<WechatAuthWaitForLoginResult> {
      const result = await waitForWeixinLogin({
        sessionKey: opts.sessionKey,
        apiBaseUrl: opts.apiBaseUrl,
        botType: opts.botType ?? DEFAULT_ILINK_BOT_TYPE,
        timeoutMs: opts.timeoutMs,
        verbose: opts.verbose,
      });
      return {
        connected: result.connected,
        message: result.message,
        botToken: result.botToken,
        accountId: result.accountId,
        baseUrl: result.baseUrl,
        userId: result.userId,
      };
    },
  };
}
