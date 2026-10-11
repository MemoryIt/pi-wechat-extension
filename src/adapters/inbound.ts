/**
 * inbound.ts - 入站消息 adapter（WechatInbound）
 *
 * 薄包装 vendor 的 `api/api.getUpdates`：把协议响应
 * `{ msgs, get_updates_buf }` 映射为端口结果 `{ messages, cursor }`。
 * 不持有任何隐藏状态，凭证与游标全部由调用方传入。
 *
 * 游标回落对齐旧 PollingLoop 语义：响应缺少 get_updates_buf 时沿用入参 cursor。
 */

import { getUpdates } from "../../api/api.js";
import type {
  WechatInbound,
  WechatInboundGetUpdatesParams,
  WechatInboundGetUpdatesResult,
} from "../ports/inbound.js";

export function createWechatInbound(): WechatInbound {
  return {
    async getUpdates(
      params: WechatInboundGetUpdatesParams,
    ): Promise<WechatInboundGetUpdatesResult> {
      const resp = await getUpdates({
        baseUrl: params.baseUrl,
        token: params.token,
        get_updates_buf: params.cursor,
        timeoutMs: params.timeoutMs,
      });
      return {
        messages: resp.msgs ?? [],
        cursor: resp.get_updates_buf ?? params.cursor,
      };
    },
  };
}
