/**
 * tests/bridge/turn-state.test.ts
 *
 * L3：用探针型假 ExtensionAPI + 假 engine 测试 index.ts 的事件桥接。
 * 覆盖：
 *   D1  去重命中后 early-return 不调用 onAiDone（队列死锁）
 *   D4  module 全局 turn 标记 + setTimeout(20ms) 导致的竞态（回复被丢弃）
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

beforeEach(() => {
  engine.onAiDone.mockClear();
  engine.sendMessageWithRetry.mockClear();
  engine.setTerminalProcessing.mockClear();
  engine.isRequestProcessed.mockClear();
  engine.isRequestProcessed.mockReturnValue(false);
  engine.markRequestProcessed.mockClear();
});

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

test("基线：微信 turn 的 agent_end 会把 AI 回复发回微信", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-ok")]);
  await beforeAgentStart({}, ctx);

  await agentEnd({ messages: [assistantMessage("hello wechat")] }, ctx);
  await sleep(40);

  expect(engine.sendMessageWithRetry).toHaveBeenCalledTimes(1);
  expect(String(engine.sendMessageWithRetry.mock.calls[0][0])).toContain("hello wechat");
});

// ---------------------------------------------------------------------------
// D1：重复 requestId 命中去重后不释放队列
// ---------------------------------------------------------------------------

test("D1 证伪：重复 requestId 命中去重后不会调用 onAiDone（队列停滞）", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-dup")]);
  await beforeAgentStart({}, ctx);

  engine.isRequestProcessed.mockReturnValue(true);
  await agentEnd({ messages: [assistantMessage("hello")] }, ctx);
  await sleep(40);

  expect(engine.onAiDone).not.toHaveBeenCalled();
});

test.failing("D1 目标：重复 requestId 命中去重后仍应调用 onAiDone 释放队列", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-dup")]);
  await beforeAgentStart({}, ctx);

  engine.isRequestProcessed.mockReturnValue(true);
  await agentEnd({ messages: [assistantMessage("hello")] }, ctx);
  await sleep(40);

  expect(engine.onAiDone).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D4：20ms 延迟 + module 全局标记导致回复错投/丢失
// ---------------------------------------------------------------------------

test("D4 证伪：微信 turn 结束后 20ms 内开始终端 turn，微信回复被丢弃", async () => {
  const wechatCtx = createFakeCtx([wechatMetaEntry("R-race")]);
  await beforeAgentStart({}, wechatCtx);
  await agentEnd({ messages: [assistantMessage("wechat reply")] }, wechatCtx);

  // 20ms 尚未到，切换成终端 turn，覆盖 module 全局标记。
  const terminalCtx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, terminalCtx);

  await sleep(40);

  expect(engine.sendMessageWithRetry).not.toHaveBeenCalled();
});

test.failing("D4 目标：前一微信 turn 的回复不应被后一终端 turn 覆盖丢弃", async () => {
  const wechatCtx = createFakeCtx([wechatMetaEntry("R-race")]);
  await beforeAgentStart({}, wechatCtx);
  await agentEnd({ messages: [assistantMessage("wechat reply")] }, wechatCtx);

  const terminalCtx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, terminalCtx);

  await sleep(40);

  expect(engine.sendMessageWithRetry).toHaveBeenCalledTimes(1);
  expect(String(engine.sendMessageWithRetry.mock.calls[0][0])).toContain("wechat reply");
});
