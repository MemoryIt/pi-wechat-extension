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
