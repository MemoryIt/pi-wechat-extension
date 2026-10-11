/**
 * tests/bridge/event-wiring.test.ts
 *
 * L3：index.ts 的事件桥接与命令 / 登录逻辑。
 * 覆盖：
 *   D11  登录成功后不得明文打印 botToken
 *   D17  订阅 agent_settled 判断整轮真正结束
 *   D18  message_start/end 只对 assistant 角色驱动 typing
 *   D19  不以空 render 覆盖内置 footer
 *   D20  /wechat start 同时 setConfig
 *   D2   发送成功后才 markRequestProcessed
 *   D5   agent_settled 兜底释放 terminal 标志
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { resetAgentDir } from "../setup/mocks";
import {
  createBridgeChannel,
  resetBridgeChannel,
  authMock,
  resetAuthMock,
  loadExtension,
  createFakePi,
} from "../setup/bridge-harness";
import {
  createFakeCtx,
  wechatMetaEntry,
  plainMessageEntry,
  assistantMessage,
  assistantEntry,
  sleep,
} from "../setup/fake-pi";

const channel = createBridgeChannel();
const register = await loadExtension({ channel, auth: authMock });
const storage = await import("../../src/storage/state.js");

const { api, handlers, commands } = createFakePi();
register(api);

const beforeAgentStart = handlers.get("before_agent_start")!;
const agentEnd = handlers.get("agent_end")!;
const agentSettled = handlers.get("agent_settled");
const wechatCommand = commands.get("wechat")!;

beforeEach(() => {
  resetAgentDir();
  resetBridgeChannel(channel);
  resetAuthMock();
});

// ---------------------------------------------------------------------------
// D11：登录成功后不得明文打印 botToken
// ---------------------------------------------------------------------------

test("D11 目标：日志中不应出现明文 botToken", async () => {
  authMock.waitForLogin.mockResolvedValue({
    connected: true,
    message: "ok",
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
// D17：订阅 agent_settled
// ---------------------------------------------------------------------------

test("D17 目标：插件应订阅 agent_settled 以判断整轮真正结束", () => {
  expect(handlers.has("agent_settled")).toBe(true);
});

// ---------------------------------------------------------------------------
// D18：message_start/end 只对 assistant 角色驱动 typing
// ---------------------------------------------------------------------------

test("D18 目标：非 assistant 消息结束不应停止 typing keepalive", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-typing")]);
  await beforeAgentStart({}, ctx);

  const messageStart = handlers.get("message_start")!;
  const messageEnd = handlers.get("message_end")!;

  await messageStart({ message: { role: "user", content: "hi" } }, ctx);
  await messageEnd({ message: { role: "user", content: "hi" } }, ctx);
  await messageStart({ message: { role: "toolResult", content: "ok" } }, ctx);
  await messageEnd({ message: { role: "toolResult", content: "ok" } }, ctx);

  expect(channel.stopTyping).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D19：不以空 render 覆盖内置 footer
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

test("D19 目标：不应把内置 footer 覆盖成空白", async () => {
  expect(await sessionStartFooterBlanked()).toBe(false);
});

// ---------------------------------------------------------------------------
// D20：/wechat start 同时 setConfig
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

test("D20 目标：/wechat start 应同时设置 channel 配置", async () => {
  await seedToken();
  const ctx = createFakeCtx();

  await wechatCommand.handler("start", ctx);

  expect(channel.startPolling).toHaveBeenCalled();
  expect(channel.setConfig).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D2：发送成功后才 markRequestProcessed
// ---------------------------------------------------------------------------

test("D2 目标：发送失败时不应把 request 标记为已处理", async () => {
  const ctx = createFakeCtx([wechatMetaEntry("R-send-fail"), assistantEntry("reply")]);
  await beforeAgentStart({}, ctx);
  channel.sendReply.mockRejectedValue(new Error("send failed"));

  await agentEnd({ messages: [assistantMessage("reply")] }, ctx);
  await agentSettled!({}, ctx);
  await sleep(20);

  expect(channel.sendReply).toHaveBeenCalled();
  expect(channel.markRequestProcessed).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// D5：agent_settled 兜底释放 terminal 标志
// ---------------------------------------------------------------------------

test("D5 基线：终端 turn 正常结束时由 agent_end 释放 terminal 标志", async () => {
  const ctx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, ctx);
  expect(channel.getTerminalProcessing()).toBe(true);

  await agentEnd({ messages: [] }, ctx);
  await sleep(20);

  expect(channel.getTerminalProcessing()).toBe(false);
});

test("D5 目标：agent_settled 应释放 terminal 处理标志", async () => {
  const ctx = createFakeCtx([plainMessageEntry()]);
  await beforeAgentStart({}, ctx);
  expect(channel.getTerminalProcessing()).toBe(true);

  await agentSettled!({}, ctx);
  await sleep(20);

  expect(channel.getTerminalProcessing()).toBe(false);
});

// ---------------------------------------------------------------------------
// 组合根隔离：两次 createExtension()(pi) 互不共享 channel
// ---------------------------------------------------------------------------

test("组合根：两次 createExtension()(pi) 创建的 channel 互相独立", async () => {
  const { Channel } = await import("../../src/channel/channel.js");
  const { createExtension } = await import("../../src/index.ts");

  const seen: unknown[] = [];
  const original = Channel.prototype.setHost;
  Channel.prototype.setHost = function (this: unknown, host: never) {
    seen.push(this);
    return original.call(this, host);
  };

  try {
    const pi1 = createFakePi();
    const pi2 = createFakePi();
    createExtension()(pi1.api as never);
    createExtension()(pi2.api as never);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  } finally {
    Channel.prototype.setHost = original;
  }
});
