/**
 * tests/bridge/turn-state.test.ts
 *
 * L3：用探针型假 ExtensionAPI + 假 engine 测试 index.ts 的事件桥接。
 * 覆盖：
 *   D1  去重命中后 early-return 仍必须调用 onAiDone（队列释放）
 *   D4  每轮 turn 身份在事件发生时同步解析，不再依赖 module 全局标记 + setTimeout
 *   D21 buildMetaInfo 增量累计成本，第二次 turn 不再重复读取旧 entry
 *
 * 注意：这里 mock 掉 ../../wechat.js，只验证 index.ts 自身的桥接逻辑，
 * 不触碰底层模块，也不依赖真实 pi 运行时。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import {
  installBaseMocks,
  repoPath,
} from "../setup/mocks";
import {
  createFakePi,
  createFakeCtx,
  assistantMessage,
  assistantEntry,
  wechatMetaEntry,
  plainMessageEntry,
  sleep,
} from "../setup/fake-pi";

installBaseMocks();

// ---- 假 engine ------------------------------------------------------------
const engine = {
  connectionState: "disconnected",
  _terminalProcessing: false,
  setTerminalProcessing: mock((v: boolean) => {
    engine._terminalProcessing = v;
  }),
  getTerminalProcessing: mock(() => engine._terminalProcessing),
  startPolling: mock(async () => {}),
  stopPolling: mock(() => {}),
  reset: mock(() => {}),
  startTypingKeepalive: mock(async () => {}),
  stopTypingKeepalive: mock(async () => {}),
  onAiDone: mock(() => {}),
  isRequestProcessed: mock(() => false),
  markRequestProcessed: mock(() => {}),
  sendMessageWithRetry: mock(async () => {}),
  sendFileToUser: mock(async () => {}),
};

// index.ts 用 "./wechat.js" 引入；同时注册 .ts 以保证解析匹配。
mock.module(repoPath("wechat.js"), () => ({
  engine,
  setPi: mock(() => {}),
  setConfig: mock(() => {}),
}));
mock.module(repoPath("wechat.ts"), () => ({
  engine,
  setPi: mock(() => {}),
  setConfig: mock(() => {}),
}));

// index.ts 还会引入登录模块（D11 将来会用到，这里先兜住，避免真实模块副作用）。
mock.module(repoPath("auth", "login-qr.js"), () => ({
  startWeixinLoginWithQr: mock(async () => ({ qrcodeUrl: "" })),
  waitForWeixinLogin: mock(async () => ({ connected: false })),
  DEFAULT_ILINK_BOT_TYPE: "test-bot-type",
}));

const extensionModule = await import("../../index.ts");
const register = extensionModule.default as (pi: unknown) => void;

const { api, handlers } = createFakePi();
register(api);

const beforeAgentStart = handlers.get("before_agent_start")!;
const agentEnd = handlers.get("agent_end")!;
const agentSettled = handlers.get("agent_settled")!;

beforeEach(() => {
  engine._terminalProcessing = false;
  engine.onAiDone.mockClear();
  engine.sendMessageWithRetry.mockClear();
  engine.setTerminalProcessing.mockClear();
  engine.stopTypingKeepalive.mockClear();
  engine.isRequestProcessed.mockClear();
  engine.isRequestProcessed.mockReturnValue(false);
  engine.markRequestProcessed.mockClear();
});

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

test("基线：微信 turn 的 agent_settled 会把最终 AI 回复发回微信", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-ok"), assistantEntry("hello wechat")]);
  await beforeAgentStart({}, ctx);

  await agentEnd({ messages: [assistantMessage("hello wechat")] }, ctx);
  await agentSettled({}, ctx);

  expect(engine.sendMessageWithRetry).toHaveBeenCalledTimes(1);
  expect(String(engine.sendMessageWithRetry.mock.calls[0][0])).toContain("hello wechat");
});

// ---------------------------------------------------------------------------
// D1：重复 requestId 命中去重后仍要释放队列
// ---------------------------------------------------------------------------

test("D1 目标：重复 requestId 命中去重后仍应调用 onAiDone 释放队列", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-dup"), assistantEntry("hello")]);
  await beforeAgentStart({}, ctx);

  engine.isRequestProcessed.mockReturnValue(true);
  await agentEnd({ messages: [assistantMessage("hello")] }, ctx);
  await agentSettled({}, ctx);

  expect(engine.sendMessageWithRetry).not.toHaveBeenCalled();
  expect(engine.onAiDone).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D4：每轮 turn 身份同步解析，后一终端 turn 不会覆盖前一微信 turn 的回复
// ---------------------------------------------------------------------------

test("D4 目标：前一微信 turn 的回复不应被后一终端 turn 覆盖丢弃", async () => {
  // 微信 turn：回复从自己的 ctx 分支解析，与之后开始的终端 turn 无共享全局状态。
  const wechatCtx = createFakeCtx([wechatMetaEntry("R-race"), assistantEntry("wechat reply")]);
  await beforeAgentStart({}, wechatCtx);
  await agentEnd({}, wechatCtx);

  // 在微信 turn settle 之前，另一个终端 turn 开始（模拟旧实现里被覆盖的 module 全局标记）。
  const terminalCtx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, terminalCtx);

  await agentSettled({}, wechatCtx);
  await agentSettled({}, terminalCtx);
  await sleep(20);

  expect(engine.sendMessageWithRetry).toHaveBeenCalledTimes(1);
  expect(String(engine.sendMessageWithRetry.mock.calls[0][0])).toContain("wechat reply");
  // 终端 turn 不得发送任何微信消息。
  expect(engine.getTerminalProcessing()).toBe(false);
});

// ---------------------------------------------------------------------------
// D4：pre-run 阶段的 turn 归属判定
// ---------------------------------------------------------------------------

test("D4 目标：wechat_meta 位于最后一条 assistant 之后时判定为微信 turn", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-new")]);
  await beforeAgentStart({}, ctx);
  expect(engine.setTerminalProcessing).not.toHaveBeenCalledWith(true);
});

test("D4 目标：微信 turn 之后的终端 turn 不应被误判为微信", async () => {
  // 上一轮微信 turn 的完整分支：meta → user → assistant。
  const ctx = createFakeCtx([
    wechatMetaEntry("R-prev"),
    { type: "message", id: "u-prev", parentId: "meta-R-prev", message: { role: "user", content: "hi" } },
    assistantEntry("prev reply", "a-prev"),
  ]);
  await beforeAgentStart({}, ctx);
  expect(engine.setTerminalProcessing).toHaveBeenCalledWith(true);
});

// ---------------------------------------------------------------------------
// D21：buildMetaInfo 增量累计成本
// ---------------------------------------------------------------------------

test("D21 目标：第二次 turn 处理不再重复读取旧 entry（增量累计成本）", async () => {
  let firstUsageReads = 0;
  const firstAssistant = {
    type: "message",
    id: "cost-A1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      get usage() {
        firstUsageReads += 1;
        return { cost: { total: 0.1 } };
      },
    },
  };
  const secondAssistant = {
    type: "message",
    id: "cost-A2",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      usage: { cost: { total: 0.2 } },
    },
  };

  // 第一次 turn：分支里只有第一条 assistant。
  const ctx1 = createFakeCtx([wechatMetaEntry("R-cost-1"), firstAssistant]);
  await beforeAgentStart({}, ctx1);
  await agentSettled({}, ctx1);
  expect(firstUsageReads).toBe(1);

  // 第二次 turn：分支在原有基础上追加了新的 entry。
  const ctx2 = createFakeCtx([
    wechatMetaEntry("R-cost-1"),
    firstAssistant,
    wechatMetaEntry("R-cost-2"),
    secondAssistant,
  ]);
  await beforeAgentStart({}, ctx2);
  await agentSettled({}, ctx2);

  // 旧 entry 不应再次被读取，但总成本仍需累计 0.1 + 0.2。
  expect(firstUsageReads).toBe(1);
  const lastReply = String(engine.sendMessageWithRetry.mock.calls.at(-1)?.[0] ?? "");
  expect(lastReply).toContain("$0.300");
});
