/**
 * outbound.ts - 出站消息 adapter（WechatOutbound）
 *
 * 薄包装 vendor 的文本/媒体发送与 typing_ticket 接口。凭证由构造时注入的
 * `getCredentials()` 提供，端口方法本身不带任何凭证参数。
 *
 * typing_ticket 语义与 `engine/typing.ts` 保持一致：
 * - 60s TTL 缓存，且绑定 contextToken（contextToken 变化即失效）
 * - 取 ticket 或发送 typing 报错信息含 "ticket" 时清空缓存
 * - 凭证缺失 / 获取失败返回 null；无 ticket 时记录日志后直接返回（不抛）
 */

import { getConfig, sendTyping as sendTypingApi } from "../../api/api.js";
import { sendMessageWeixin } from "../../messaging/send.js";
import { sendWeixinMediaFile } from "../../messaging/send-media.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatCredentials } from "../ports/types.js";

/** typing_ticket 缓存有效期（与 engine/typing.ts 一致）。 */
const TYPING_TICKET_CACHE_TTL_MS = 60_000;

/** 媒体上传/下载使用的 CDN 基址（与 engine/sender.ts 一致）。 */
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface WechatOutboundLogger {
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface WechatOutboundDeps {
  getCredentials(): WechatCredentials | null;
  logger?: WechatOutboundLogger;
}

const NOOP_LOGGER: WechatOutboundLogger = {
  debug: () => {},
  error: () => {},
};

export function createWechatOutbound(deps: WechatOutboundDeps): WechatOutbound {
  const logger = deps.logger ?? NOOP_LOGGER;

  let ticketCache: {
    ticket: string;
    expiresAt: number;
    contextToken: string;
  } | null = null;

  const getTypingTicket = async (): Promise<string | null> => {
    const creds = deps.getCredentials();
    if (!creds) {
      return null;
    }

    // 缓存必须与当前 contextToken 匹配；token 变化后旧 ticket 立即失效。
    if (
      ticketCache &&
      ticketCache.contextToken === creds.contextToken &&
      Date.now() < ticketCache.expiresAt
    ) {
      return ticketCache.ticket;
    }

    try {
      const configResp = await getConfig({
        baseUrl: creds.baseUrl,
        token: creds.token,
        ilinkUserId: creds.userId,
        contextToken: creds.contextToken,
      });

      if (configResp.ret === 0 && configResp.typing_ticket) {
        ticketCache = {
          ticket: configResp.typing_ticket,
          expiresAt: Date.now() + TYPING_TICKET_CACHE_TTL_MS,
          contextToken: creds.contextToken,
        };
        return configResp.typing_ticket;
      }
    } catch (err) {
      logger.error(`[Wechat] getTypingTicket failed:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("ticket")) {
        ticketCache = null;
      }
    }

    return null;
  };

  const sendTyping = async (status: 1 | 2): Promise<void> => {
    const creds = deps.getCredentials();
    if (!creds) {
      return;
    }

    const ticket = await getTypingTicket();
    if (!ticket) {
      logger.error(`[Wechat] sendTypingStatus: failed to get typing_ticket`);
      return;
    }

    try {
      await sendTypingApi({
        baseUrl: creds.baseUrl,
        token: creds.token,
        body: {
          ilink_user_id: creds.userId,
          typing_ticket: ticket,
          status,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[Wechat] sendTypingStatus failed:`, errMsg);
      if (errMsg.includes("ticket")) {
        ticketCache = null;
      }
    }
  };

  return {
    async sendText(text: string): Promise<void> {
      const creds = deps.getCredentials();
      if (!creds) {
        throw new Error("Single user not initialized");
      }
      logger.debug(`sendTextMessage: text length=${text.length}`);

      await sendMessageWeixin({
        to: creds.userId,
        text,
        opts: {
          baseUrl: creds.baseUrl,
          token: creds.token,
          contextToken: creds.contextToken,
        },
      });
      logger.debug(`sendTextMessage: 文字消息发送成功`);
    },

    async sendFile(localPath: string): Promise<void> {
      if (!localPath || typeof localPath !== "string") {
        throw new Error("sendFileToUser: localPath 不能为空");
      }

      const creds = deps.getCredentials();
      if (!creds) {
        throw new Error("Single user not initialized");
      }

      logger.debug(`sendFileToUser START: localPath=${localPath}`);

      const opts = {
        baseUrl: creds.baseUrl,
        token: creds.token,
        contextToken: creds.contextToken,
      };

      await sendWeixinMediaFile({
        filePath: localPath,
        to: creds.userId,
        text: "",
        opts,
        cdnBaseUrl: WEIXIN_CDN_BASE_URL,
      });

      logger.debug(`sendFileToUser COMPLETE: 文件已通过官方 sendWeixinMediaFile 发送成功`);
    },

    sendTyping,
    getTypingTicket,
  };
}
