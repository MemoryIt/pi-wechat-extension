/**
 * channel/inbound-parser.ts - 入站消息解析（微信方言 -> 内部文本/标志）
 *
 * 纯函数、无副作用：把原先散落在编排层的 `item_list` 解析集中于此，供
 * `MessageRouter`（文本/媒体分支）复用。
 *
 * 仅依赖 `ports/types` 的协议类型，不引入任何通道编排依赖。
 */

import type { WeixinMessage } from "../ports/types.js";
import { MessageItemType } from "../ports/types.js";

export interface ParsedInbound {
  /** 所有 TEXT 项以 "\n" 拼接（原始文本，不 trim、不过滤空串）。 */
  text: string;
  /** 存在 TEXT 项且 text_item?.text?.trim() 为真（空白文本不算）。 */
  hasText: boolean;
  /** 存在 type !== TEXT 的 item。 */
  hasMedia: boolean;
}

/**
 * 解析一条入站微信消息。
 *
 * 空消息 / `item_list` 缺失时三个字段均为空值。
 */
export function parseInbound(msg: WeixinMessage): ParsedInbound {
  const parts: string[] = [];
  let hasText = false;
  let hasMedia = false;

  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT) {
      const text = item.text_item?.text ?? "";
      parts.push(text);
      if (!hasText && text.trim()) hasText = true;
    } else {
      hasMedia = true;
    }
  }

  return { text: parts.join("\n"), hasText, hasMedia };
}
