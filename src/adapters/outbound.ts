/**
 * ACL: src/adapters/outbound.ts — 出站消息的 Anti-Corruption Layer
 *
 * 本文件是自写层唯一接触 vendor 发送接口（messaging/send、messaging/send-media、
 * api/api 的 getConfig/sendTyping）的地方。
 * 翻译：把端口方法补齐为 vendor 需要的 `to`/`opts`；凭证只来自构造时注入的
 *       `getCredentials()` provider，端口方法本身不带凭证参数。
 * 有意隐藏/丢弃：固定 CDN 基址（novac2c…）封装在 adapter 内，不暴露给上层；
 *       vendor 的 clientId / MessageState 等协议细节不外泄；typing ticket 不缓存，
 *       有效期 / contextToken 绑定 / 失效逻辑留在上层 TypingController。
 * 边界纪律：vendor 类型、CDN 路径、全局状态不得泄漏回上层；
 *       上层只依赖 `src/ports/outbound.ts` 的端口类型（含 ports/types 凭证类型）。
 */
/**
 * outbound.ts - 出站消息 adapter（WechatOutbound）
 *
 * 薄包装 vendor 的文本/媒体发送与 typing_ticket 接口。凭证由构造时注入的
 * `getCredentials()` 提供，端口方法本身不带任何凭证参数。
 *
 * 端口薄：不持有 ticket 状态。ticket 的有效期 / contextToken 绑定 /
 * 失效逻辑全部留在 `engine/typing.ts` 的 TypingController。
 */

import { getConfig, sendTyping as sendTypingApi } from "../../api/api.js";
import { sendMessageWeixin } from "../../messaging/send.js";
import { sendWeixinMediaFile } from "../../messaging/send-media.js";
import type { WechatOutbound } from "../ports/outbound.js";
import type { WechatCredentials } from "../ports/types.js";

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

  const getTypingTicket = async (): Promise<string | null> => {
    const creds = deps.getCredentials();
    if (!creds) {
      return null;
    }

    try {
      const configResp = await getConfig({
        baseUrl: creds.baseUrl,
        token: creds.token,
        ilinkUserId: creds.userId,
        contextToken: creds.contextToken,
      });

      if (configResp.ret === 0 && configResp.typing_ticket) {
        return configResp.typing_ticket;
      }
    } catch (err) {
      logger.error(`[Wechat] getTypingTicket failed:`, err);
    }

    return null;
  };

  const sendTyping = async (status: 1 | 2, ticket: string): Promise<void> => {
    const creds = deps.getCredentials();
    if (!creds) {
      return;
    }

    await sendTypingApi({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        ilink_user_id: creds.userId,
        typing_ticket: ticket,
        status,
      },
    });
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
