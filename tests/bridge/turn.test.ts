/**
 * tests/bridge/turn.test.ts
 *
 * turn.ts 纯函数单测：turn 身份解析 / FIFO 兜底 / 回复提取。
 * 不依赖 pi 运行时、不 mock 底层模块。
 */
import { test, expect, beforeEach } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolvePendingWechatMeta,
  resolveActiveWechatMeta,
  resolveTurnBeforeRun,
  resolveTurnFromBranch,
  extractLastReply,
  extractReplyText,
  isAssistantMessage,
  pushPendingWechatInput,
  resetPendingWechatInputs,
  type BranchEntry,
} from "../../src/bridge/turn.js";

interface RawEntry extends BranchEntry {
  parentId?: string | null;
  data?: { requestId?: string };
}

function makeCtx(branch: RawEntry[], entries: Record<string, unknown> = {}): ExtensionContext {
  return {
    sessionManager: {
      getBranch: () => branch,
      getEntry: (id: string) => entries[id],
    },
  } as unknown as ExtensionContext;
}

const meta = (requestId: string): RawEntry => ({
  type: "custom",
  id: `meta-${requestId}`,
  customType: "wechat_meta",
  data: { requestId },
});

const assistant = (text: string, id = `a-${text}`): RawEntry => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

beforeEach(() => {
  resetPendingWechatInputs();
});

test("resolvePendingWechatMeta：meta 位于最后一条 assistant 之后时为微信 turn", () => {
  const ctx = makeCtx([assistant("old"), meta("R-1")]);
  expect(resolvePendingWechatMeta(ctx)).toEqual({ requestId: "R-1" });
});

test("resolvePendingWechatMeta：assistant 在 meta 之后说明上一轮已结束", () => {
  const ctx = makeCtx([meta("R-1"), assistant("done")]);
  expect(resolvePendingWechatMeta(ctx)).toBeNull();
});

test("resolveActiveWechatMeta：通过 user.parentId 反向关联 wechat_meta", () => {
  const ctx = makeCtx(
    [
      meta("R-2"),
      { type: "message", id: "u-1", parentId: "meta-R-2", message: { role: "user", content: "hi" } },
    ],
    { "meta-R-2": { type: "custom", customType: "wechat_meta", data: { requestId: "R-2" } } },
  );
  expect(resolveActiveWechatMeta(ctx)).toEqual({ requestId: "R-2" });
  expect(resolveTurnFromBranch(ctx)).toEqual({ fromWechat: true, requestId: "R-2" });
});

test("resolveTurnBeforeRun：无 meta 时用 prompt 与 FIFO 兜底", () => {
  pushPendingWechatInput({ requestId: "R-3", text: "hello from wechat" });
  const ctx = makeCtx([]);
  expect(resolveTurnBeforeRun(ctx, "hello from wechat")).toEqual({ fromWechat: true, requestId: "R-3" });
  // FIFO 命中后应被消费，再次用同一 prompt 不再判定为微信 turn。
  expect(resolveTurnBeforeRun(ctx, "hello from wechat")).toEqual({ fromWechat: false, requestId: null });
});

test("resolveTurnBeforeRun：无 meta 且无 prompt 时为终端 turn", () => {
  const ctx = makeCtx([]);
  expect(resolveTurnBeforeRun(ctx)).toEqual({ fromWechat: false, requestId: null });
});

test("isAssistantMessage：仅 assistant 角色为真", () => {
  expect(isAssistantMessage({ message: { role: "assistant" } })).toBe(true);
  expect(isAssistantMessage({ message: { role: "user" } })).toBe(false);
  expect(isAssistantMessage({})).toBe(false);
});

test("extractReplyText：string / text block 数组 / object 三种形态", () => {
  expect(extractReplyText({ content: "  hi  " })).toBe("hi");
  expect(extractReplyText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb");
  expect(extractReplyText({ content: { text: " obj " } })).toBe("obj");
  expect(extractReplyText({ content: [] })).toBeNull();
});

test("extractLastReply：返回最后一条有文本的 assistant 回复", () => {
  const ctx = makeCtx([assistant("first"), { type: "message", id: "u", message: { role: "user", content: "x" } }, assistant("last")]);
  expect(extractLastReply(ctx)).toBe("last");
});
