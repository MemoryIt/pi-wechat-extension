/**
 * tests/application/reply.test.ts
 *
 * L1：`ReplyService.handleSettled` 的发送决策（直接用 fake `ReplyChannel`，不经过 pi）。
 * 覆盖 rf-1 行为契约：
 *   - fromWechat=false → setTerminalProcessing(false) + onAiDone，不发送
 *   - 成功路径顺序 stopTyping → sendReply → markRequestProcessed → onAiDone
 *   - sendReply 抛错 → 不 mark、notify(error)、onAiDone
 *   - 已处理 / 无 requestId / 无 replyText → 不发送、onAiDone
 *   - metaText 拼接格式
 */
import { test, expect, mock } from "bun:test";
import { ReplyService } from "../../src/application/reply.js";
import type { ReplyChannel, SettledContext } from "../../src/application/types.js";
import { createLogger } from "../../src/shared/logger.js";

const silentLogger = createLogger({
  isDebugEnabled: () => false,
  sink: { log: () => {}, warn: () => {}, error: () => {} },
});

interface FakeChannel {
  channel: ReplyChannel;
  calls: string[];
}

function createFakeChannel(overrides: Partial<ReplyChannel> = {}): FakeChannel {
  const calls: string[] = [];
  const channel: ReplyChannel = {
    isRequestProcessed: mock(() => false),
    stopTyping: mock(async () => {
      calls.push("stopTyping");
    }),
    sendReply: mock(async () => {
      calls.push("sendReply");
    }),
    markRequestProcessed: mock(() => {
      calls.push("markRequestProcessed");
    }),
    setTerminalProcessing: mock(() => {
      calls.push("setTerminalProcessing");
    }),
    onAiDone: mock(() => {
      calls.push("onAiDone");
    }),
    ...overrides,
  };
  return { channel, calls };
}

function createContext(overrides: Partial<SettledContext> = {}): SettledContext {
  return {
    fromWechat: true,
    requestId: "R-1",
    replyText: "hello",
    metaText: null,
    notify: mock(() => {}),
    ...overrides,
  };
}

function serviceWith(channel: ReplyChannel): ReplyService {
  return new ReplyService({ channel, logger: silentLogger });
}

// ---------------------------------------------------------------------------
// fromWechat=false（终端 turn）
// ---------------------------------------------------------------------------

test("fromWechat=false：释放 terminal 标志并 onAiDone，不发送", async () => {
  const { channel, calls } = createFakeChannel();
  const ctx = createContext({ fromWechat: false, requestId: null, replyText: null });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.setTerminalProcessing).toHaveBeenCalledWith(false);
  expect(calls).toEqual(["setTerminalProcessing", "onAiDone"]);
  expect(channel.stopTyping).not.toHaveBeenCalled();
  expect(channel.sendReply).not.toHaveBeenCalled();
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

test("成功路径顺序：stopTyping → sendReply → markRequestProcessed → onAiDone", async () => {
  const { channel, calls } = createFakeChannel();
  const ctx = createContext({ requestId: "R-1", replyText: "hello" });

  await serviceWith(channel).handleSettled(ctx);

  expect(calls).toEqual(["stopTyping", "sendReply", "markRequestProcessed", "onAiDone"]);
  expect(channel.sendReply).toHaveBeenCalledWith("hello");
  expect(channel.markRequestProcessed).toHaveBeenCalledWith("R-1");
  expect(ctx.notify).not.toHaveBeenCalled();
  expect(channel.setTerminalProcessing).not.toHaveBeenCalled();
});

test("metaText 拼接格式：replyText + 空行 + metaText", async () => {
  const { channel } = createFakeChannel();
  const ctx = createContext({ replyText: "body", metaText: "/repo (main)\n(anthropic) claude" });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.sendReply).toHaveBeenCalledWith("body\n\n/repo (main)\n(anthropic) claude");
});

test("metaText 为空时不追加空行", async () => {
  const { channel } = createFakeChannel();
  const ctx = createContext({ replyText: "body", metaText: null });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.sendReply).toHaveBeenCalledWith("body");
});

// ---------------------------------------------------------------------------
// 发送失败（D2）
// ---------------------------------------------------------------------------

test("sendReply 抛错：不 mark、notify(error)、onAiDone", async () => {
  const { channel } = createFakeChannel();
  (channel.sendReply as ReturnType<typeof mock>).mockRejectedValue(new Error("network down"));
  const ctx = createContext({ requestId: "R-1", replyText: "hello" });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.sendReply).toHaveBeenCalledTimes(1);
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
  expect(ctx.notify).toHaveBeenCalledWith("微信回复失败: network down", "error");
  expect(channel.onAiDone).toHaveBeenCalledTimes(1);
});

test("sendReply 抛出非 Error 值：notify 使用 String(err)", async () => {
  const { channel } = createFakeChannel();
  (channel.sendReply as ReturnType<typeof mock>).mockRejectedValue("boom");
  const ctx = createContext();

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
  expect(ctx.notify).toHaveBeenCalledWith("微信回复失败: boom", "error");
  expect(channel.onAiDone).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 早退路径：都必须最终 onAiDone 且不发送（D1）
// ---------------------------------------------------------------------------

test("requestId=null：不发送、onAiDone", async () => {
  const { channel, calls } = createFakeChannel();
  const ctx = createContext({ requestId: null, replyText: "hello" });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.sendReply).not.toHaveBeenCalled();
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
  expect(calls).toEqual(["onAiDone"]);
});

test("requestId 已被处理：不发送、onAiDone", async () => {
  const { channel, calls } = createFakeChannel({
    isRequestProcessed: mock(() => true),
  });
  const ctx = createContext({ requestId: "R-1", replyText: "hello" });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.isRequestProcessed).toHaveBeenCalledWith("R-1");
  expect(channel.sendReply).not.toHaveBeenCalled();
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
  expect(calls).toEqual(["onAiDone"]);
});

test("无 replyText：不发送、onAiDone", async () => {
  const { channel, calls } = createFakeChannel();
  const ctx = createContext({ requestId: "R-1", replyText: null });

  await serviceWith(channel).handleSettled(ctx);

  expect(channel.sendReply).not.toHaveBeenCalled();
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
  expect(calls).toEqual(["onAiDone"]);
});
