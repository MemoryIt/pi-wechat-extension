/**
 * tests/channel/inbound-parser.test.ts
 *
 * CS-2：直接单测纯解析模块 `parseInbound`（微信 item_list -> 内部文本/标志）。
 * 原 `channel.test.ts` 的 D15（slash 判定）用例已迁移至此，断言强度不变。
 */
import { test, expect } from "bun:test";
import { parseInbound } from "../../src/channel/inbound-parser.js";
import { MessageItemType } from "../../src/ports/types.js";
import type { WeixinMessage } from "../../src/ports/types.js";

function textItem(text: string) {
  return { type: MessageItemType.TEXT, text_item: { text } };
}

function mediaItem(type = MessageItemType.IMAGE) {
  return { type, image_item: {} } as never;
}

// ---------------------------------------------------------------------------
// 空消息 / item_list 缺失
// ---------------------------------------------------------------------------

test("parseInbound：item_list 缺失 → 四字段全空", () => {
  expect(parseInbound({})).toEqual({ text: "", isCommand: false, hasText: false, hasMedia: false });
});

test("parseInbound：item_list 为空数组 → 四字段全空", () => {
  expect(parseInbound({ item_list: [] })).toEqual({
    text: "",
    isCommand: false,
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
  expect(parsed.isCommand).toBe(false);
});

test("parseInbound：多个 TEXT 含空串 → 空串保留，仍以 \\n 相连", () => {
  expect(parseInbound({ item_list: [textItem("a"), textItem(""), textItem("b")] }).text).toBe("a\n\nb");
});

test("parseInbound：空白文本 → text 保留原文、hasText=false", () => {
  const parsed = parseInbound({ item_list: [textItem("   ")] });
  expect(parsed.text).toBe("   ");
  expect(parsed.hasText).toBe(false);
  expect(parsed.isCommand).toBe(false);
});

// ---------------------------------------------------------------------------
// isCommand（含原 D15 断言）
// ---------------------------------------------------------------------------

test("parseInbound：'/help' → isCommand=true（原 D15 基线）", () => {
  expect(parseInbound({ item_list: [textItem("/help")] }).isCommand).toBe(true);
});

test("parseInbound：普通文本 'hi' → isCommand=false（原 D15 基线）", () => {
  expect(parseInbound({ item_list: [textItem("hi")] }).isCommand).toBe(false);
});

test("parseInbound：'  /help  ' 前后空白 → isCommand=true", () => {
  expect(parseInbound({ item_list: [textItem("  /help  ")] }).isCommand).toBe(true);
});

test("parseInbound：'/unknown' 未知命令 → isCommand=true", () => {
  expect(parseInbound({ item_list: [textItem("/unknown")] }).isCommand).toBe(true);
});

test("parseInbound：slash 出现在第 2 个 TEXT 项 → isCommand=true（原 D15 目标）", () => {
  const msg: WeixinMessage = {
    item_list: [
      { type: MessageItemType.IMAGE, image_item: {} } as never,
      textItem("/help"),
    ],
  };
  expect(parseInbound(msg).isCommand).toBe(true);
});

test("parseInbound：第 2 个 TEXT 项为普通文本 → isCommand=false", () => {
  expect(parseInbound({ item_list: [textItem("hello"), textItem("world")] }).isCommand).toBe(false);
});

// ---------------------------------------------------------------------------
// hasMedia / hasText 组合
// ---------------------------------------------------------------------------

test("parseInbound：纯媒体（IMAGE）→ hasMedia=true、hasText=false、text=''、isCommand=false", () => {
  expect(parseInbound({ item_list: [mediaItem()] })).toEqual({
    text: "",
    isCommand: false,
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
