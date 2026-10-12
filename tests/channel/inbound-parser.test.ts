/**
 * tests/channel/inbound-parser.test.ts
 *
 * 直接单测纯解析模块 `parseInbound`（微信 item_list -> 内部文本/标志）。
 * CS-3：`isCommand` 已随自研层 slash 拦截一并移除，契约收敛为
 * `{ text, hasText, hasMedia }`。
 */
import { test, expect } from "bun:test";
import { parseInbound } from "../../src/channel/inbound-parser.js";
import { MessageItemType } from "../../src/ports/types.js";

function textItem(text: string) {
  return { type: MessageItemType.TEXT, text_item: { text } };
}

function mediaItem(type = MessageItemType.IMAGE) {
  return { type, image_item: {} } as never;
}

// ---------------------------------------------------------------------------
// 空消息 / item_list 缺失
// ---------------------------------------------------------------------------

test("parseInbound：item_list 缺失 → 三字段全空", () => {
  expect(parseInbound({})).toEqual({ text: "", hasText: false, hasMedia: false });
});

test("parseInbound：item_list 为空数组 → 三字段全空", () => {
  expect(parseInbound({ item_list: [] })).toEqual({
    text: "",
    hasText: false,
    hasMedia: false,
  });
});

// ---------------------------------------------------------------------------
// text 拼接
// ---------------------------------------------------------------------------

test("parseInbound：单个 TEXT → text 原文", () => {
  expect(parseInbound({ item_list: [textItem("hello")] }).text).toBe("hello");
});

test("parseInbound：多个 TEXT → 以 \\n 精确拼接（不 trim、不过滤空串）", () => {
  const parsed = parseInbound({ item_list: [textItem("a"), textItem("b"), textItem("c")] });
  expect(parsed.text).toBe("a\nb\nc");
  expect(parsed.hasText).toBe(true);
});

test("parseInbound：多个 TEXT 含空串 → 空串保留，仍以 \\n 相连", () => {
  expect(parseInbound({ item_list: [textItem("a"), textItem(""), textItem("b")] }).text).toBe("a\n\nb");
});

test("parseInbound：空白文本 → text 保留原文、hasText=false", () => {
  const parsed = parseInbound({ item_list: [textItem("   ")] });
  expect(parsed.text).toBe("   ");
  expect(parsed.hasText).toBe(false);
});

// ---------------------------------------------------------------------------
// hasMedia / hasText 组合
// ---------------------------------------------------------------------------

test("parseInbound：纯媒体（IMAGE）→ hasMedia=true、hasText=false、text=''", () => {
  expect(parseInbound({ item_list: [mediaItem()] })).toEqual({
    text: "",
    hasText: false,
    hasMedia: true,
  });
});

test("parseInbound：文本 + 媒体混合 → hasMedia=true、hasText=true", () => {
  const parsed = parseInbound({ item_list: [textItem("hi"), mediaItem()] });
  expect(parsed.hasMedia).toBe(true);
  expect(parsed.hasText).toBe(true);
  expect(parsed.text).toBe("hi");
});

test("parseInbound：类型未知（undefined type）按非 TEXT 处理 → hasMedia=true", () => {
  const parsed = parseInbound({ item_list: [{}] });
  expect(parsed.hasMedia).toBe(true);
  expect(parsed.hasText).toBe(false);
  expect(parsed.text).toBe("");
});
