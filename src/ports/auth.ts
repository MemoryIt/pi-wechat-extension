/**
 * ports/auth.ts - 登录认证端口（WechatAuth）
 *
 * 二维码登录两步：`startQr` 生成二维码，`waitForLogin` 轮询扫码结果。
 * 字段对齐现有 `auth/login-qr` 的用法，便于后续 adapter 直接包装。
 *
 * 仅类型定义，无运行时逻辑。
 */

export interface WechatAuthStartQrOpts {
  apiBaseUrl: string;
  /** 会话键；缺省由 adapter 生成。 */
  accountId?: string;
  botType?: string;
  /** 忽略已有可用二维码，强制重新生成。 */
  force?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}

export interface WechatAuthStartQrResult {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
}

export interface WechatAuthWaitForLoginOpts {
  sessionKey: string;
  apiBaseUrl: string;
  botType?: string;
  timeoutMs?: number;
  verbose?: boolean;
}

export interface WechatAuthWaitForLoginResult {
  connected: boolean;
  message: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  /** 扫码用户 ID；后续加入 allowFrom。 */
  userId?: string;
}

export interface WechatAuth {
  startQr(opts: WechatAuthStartQrOpts): Promise<WechatAuthStartQrResult>;
  waitForLogin(opts: WechatAuthWaitForLoginOpts): Promise<WechatAuthWaitForLoginResult>;
}
