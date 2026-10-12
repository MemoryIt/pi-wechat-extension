/**
 * ACL: src/adapters/inbound.ts — 入站消息的 Anti-Corruption Layer
 *
 * 本文件是自写层唯一接触 vendor `api/api.getUpdates` 的地方。
 * 翻译：vendor 响应 `{ msgs, get_updates_buf }` → 端口 `{ messages, cursor }`；
 *       缺少 `get_updates_buf` 时回落到入参 `cursor`（对齐旧 PollingLoop 语义）。
 * 有意隐藏/丢弃：vendor 的 ret/errmsg 等协议字段、长轮询默认超时、隐藏状态一律不保留；
 *       凭证与游标始终由调用方显式传入。
 * 边界纪律：vendor 类型、vendor 路径、vendor 全局状态不得泄漏回上层；
 *       上层只依赖 `src/ports/inbound.ts` 的端口类型。
 */
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
