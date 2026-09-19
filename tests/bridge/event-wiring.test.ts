/**
 * tests/bridge/event-wiring.test.ts
 *
 * L3：index.ts 的事件桥接与命令 / 登录逻辑。
 * 覆盖：
 *   D11  登录成功后明文打印 botToken
 *   D17  只监听 agent_end，未使用 agent_settled（pi 会重试/压缩/续跑）
 *   D18  message_start/end 对所有角色触发，导致 typing 被过早关闭
 *   D19  setFooter 覆盖内置 footer（render 返回空数组）
 *   D20  /wechat start 未调用 setConfig
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { resetAgentDir } from "../setup/mocks";
import {
  createBridgeEngine,
  resetBridgeEngine,
  installBridgeMocks,
  authMock,
  resetAuthMock,
  setConfigMock,
  loadIndex,
  createFakePi,
} from "../setup/bridge-harness";
import { createFakeCtx, wechatMetaEntry, plainMessageEntry, assistantMessage, sleep } from "../setup/fake-pi";

const engine = createBridgeEngine();
installBridgeMocks(engine);

const register = await loadIndex();
const storage = await import("../../storage/state.js");

const { api, handlers, commands } = createFakePi();
register(api);

const beforeAgentStart = handlers.get("before_agent_start")!;
const wechatCommand = commands.get("wechat")!;

beforeEach(() => {
  resetAgentDir();
  resetBridgeEngine(engine);
  resetAuthMock();
  setConfigMock.mockClear();
});

// ---------------------------------------------------------------------------
// D11：登录成功后明文打印 botToken
// ---------------------------------------------------------------------------

test("D11 证伪：登录成功后会把 botToken 明文打到日志", async () => {
  authMock.waitForWeixinLogin.mockResolvedValue({
    connected: true,
    accountId: "acc1",
    botToken: "SECRET-BOT-TOKEN",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });

  const ctx = createFakeCtx();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;

  try {
    await wechatCommand.handler("login", ctx);
  } finally {
    console.log = origLog;
  }

  expect(logs.join("\n")).toContain("SECRET-BOT-TOKEN");
});

test.failing("D11 目标：日志中不应出现明文 botToken", async () => {
  authMock.waitForWeixinLogin.mockResolvedValue({
    connected: true,
    accountId: "acc1",
    botToken: "SECRET-BOT-TOKEN",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });

  const ctx = createFakeCtx();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;

  try {
    await wechatCommand.handler("login", ctx);
  } finally {
    console.log = origLog;
  }

  expect(logs.join("\n")).not.toContain("SECRET-BOT-TOKEN");
});

// ---------------------------------------------------------------------------
// D17：只监听 agent_end，没有使用 agent_settled
// ---------------------------------------------------------------------------

test("D17 证伪：插件没有订阅 agent_settled（pi 会重试/压缩/续跑）", () => {
  expect(handlers.has("agent_settled")).toBe(false);
});

test.failing("D17 目标：插件应订阅 agent_settled 以判断整轮真正结束", () => {
  expect(handlers.has("agent_settled")).toBe(true);
});

test("D17 证伪：单独触发 agent_settled 不会发送回复（因为没有处理逻辑）", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-settle")]);
  await beforeAgentStart({}, ctx);

  const settled = handlers.get("agent_settled");
  if (settled) await settled({}, ctx);
  await sleep(30);

  expect(engine.sendMessageWithRetry).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D18：message_start/end 对所有角色触发，typing 被过早关闭
// ---------------------------------------------------------------------------

test("D18 证伪：user/toolResult 的 message_end 会提前停止 typing keepalive", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-typing")]);
  await beforeAgentStart({}, ctx);

  const messageStart = handlers.get("message_start")!;
  const messageEnd = handlers.get("message_end")!;

  await messageStart({ message: { role: "user", content: "hi" } }, ctx);
  await messageEnd({ message: { role: "user", content: "hi" } }, ctx);
  await messageStart({ message: { role: "toolResult", content: "ok" } }, ctx);
  await messageEnd({ message: { role: "toolResult", content: "ok" } }, ctx);

  expect(engine.stopTypingKeepalive).toHaveBeenCalled();
});

test.failing("D18 目标：非 assistant 消息结束不应停止 typing keepalive", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-typing")]);
  await beforeAgentStart({}, ctx);

  const messageStart = handlers.get("message_start")!;
  const messageEnd = handlers.get("message_end")!;

  await messageStart({ message: { role: "user", content: "hi" } }, ctx);
  await messageEnd({ message: { role: "user", content: "hi" } }, ctx);
  await messageStart({ message: { role: "toolResult", content: "ok" } }, ctx);
  await messageEnd({ message: { role: "toolResult", content: "ok" } }, ctx);

  expect(engine.stopTypingKeepalive).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D19：setFooter 覆盖内置 footer
// ---------------------------------------------------------------------------

async function sessionStartFooterBlanked(): Promise<boolean> {
  const ctx = createFakeCtx();
  await handlers.get("session_start")!({ reason: "startup" }, ctx);

  if (!ctx.ui.setFooter.mock.calls.length) {
    // 没有覆盖 footer，也就没有把它清空
    return false;
  }

  const factory = ctx.ui.setFooter.mock.calls[0][0] as (
    tui: unknown,
    theme: unknown,
    footerData: unknown,
  ) => { render: (width: number) => string[]; dispose?: () => void };

  const comp = factory(
    { requestRender: () => {} },
    {},
    { getGitBranch: () => "main", onBranchChange: () => () => {} },
  );
  const lines = comp.render(80);
  return Array.isArray(lines) && lines.length === 0;
}

test("D19 证伪：session_start 会用空 render 覆盖内置 footer", async () => {
  expect(await sessionStartFooterBlanked()).toBe(true);
});

test.failing("D19 目标：不应把内置 footer 覆盖成空白", async () => {
  expect(await sessionStartFooterBlanked()).toBe(false);
});

// ---------------------------------------------------------------------------
// D20：/wechat start 未调用 setConfig
// ---------------------------------------------------------------------------

async function seedToken() {
  await storage.saveToken("acc1", {
    botToken: "bot-token-abc",
    accountId: "acc1",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
    loginAt: Date.now(),
  });
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });
}

test("D20 证伪：/wechat start 启动轮询但没有 setConfig", async () => {
  await seedToken();
  const ctx = createFakeCtx();

  await wechatCommand.handler("start", ctx);

  expect(engine.startPolling).toHaveBeenCalled();
  expect(setConfigMock).not.toHaveBeenCalled();
});

test.failing("D20 目标：/wechat start 应同时设置 engine 配置", async () => {
  await seedToken();
  const ctx = createFakeCtx();

  await wechatCommand.handler("start", ctx);

  expect(engine.startPolling).toHaveBeenCalled();
  expect(setConfigMock).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D2：发送前就 markRequestProcessed，导致发送失败不可重试
// ---------------------------------------------------------------------------

test("D2 证伪：发送失败后该 request 仍被标记为已处理（无法重试）", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-send-fail")]);
  await beforeAgentStart({}, ctx);
  engine.sendMessageWithRetry.mockRejectedValue(new Error("send failed"));

  await handlers.get("agent_end")!({ messages: [assistantMessage("reply")] }, ctx);
  await sleep(40);

  expect(engine.sendMessageWithRetry).toHaveBeenCalled();
  expect(engine.markRequestProcessed).toHaveBeenCalledWith("R-send-fail");
});

test.failing("D2 目标：发送失败时不应把 request 标记为已处理", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-send-fail")]);
  await beforeAgentStart({}, ctx);
  engine.sendMessageWithRetry.mockRejectedValue(new Error("send failed"));

  await handlers.get("agent_end")!({ messages: [assistantMessage("reply")] }, ctx);
  await sleep(40);

  expect(engine.sendMessageWithRetry).toHaveBeenCalled();
  expect(engine.markRequestProcessed).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D5：isTerminalMessageProcessing 在缺失 agent_end 时卡死
// ---------------------------------------------------------------------------

test("D5 基线：终端 turn 正常结束时由 agent_end 释放 terminal 标志", async () => {
  const ctx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, ctx);
  expect(engine.getTerminalProcessing()).toBe(true);

  await handlers.get("agent_end")!({ messages: [] }, ctx);
  await sleep(20);

  expect(engine.getTerminalProcessing()).toBe(false);
});

test("D5 证伪：终端 turn 只收到 agent_settled（无 agent_end）时 terminal 标志卡在 true", async () => {
  const ctx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, ctx);
  expect(engine.getTerminalProcessing()).toBe(true);

  // agent_settled 是 pi 在 _runAgentPrompt 的 finally 中触发的可靠「本轮结束」信号。
  const settled = handlers.get("agent_settled");
  if (settled) await settled({}, ctx);
  await sleep(20);

  expect(engine.getTerminalProcessing()).toBe(true);
});

test.failing("D5 目标：agent_settled 应释放 terminal 处理标志", async () => {
  const ctx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, ctx);
  expect(engine.getTerminalProcessing()).toBe(true);

  const settled = handlers.get("agent_settled");
  if (settled) await settled({}, ctx);
  await sleep(20);

  expect(engine.getTerminalProcessing()).toBe(false);
});
