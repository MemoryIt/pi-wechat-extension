/**
 * ports/inbound.ts - 入站消息端口（WechatInbound）
 *
 * 通道核心只需要「拉取更新」这一个入站操作。游标（cursor）为上一次
 * 响应的完整上下文 buf；timeoutMs 缺省时由 adapter 决定长轮询超时。
 *
 * 仅类型定义，无运行时逻辑。
 */

import type { WeixinMessage } from "./types.js";

/** getUpdates 入参：凭证与游标由调用方提供，不带任何隐藏状态。 */
export interface WechatInboundGetUpdatesParams {
  /** 上一次响应返回的上下文游标；首次或重置时为空串。 */
  cursor: string;
  baseUrl: string;
  token: string;
  /** 客户端长轮询超时（毫秒）；缺省由 adapter 采用默认值。 */
  timeoutMs?: number;
}

/** getUpdates 结果：本次收到的消息 + 下次请求应携带的游标。 */
export interface WechatInboundGetUpdatesResult {
  messages: WeixinMessage[];
  cursor: string;
}

export interface WechatInbound {
  getUpdates(params: WechatInboundGetUpdatesParams): Promise<WechatInboundGetUpdatesResult>;
}
