/**
 * tests/channel/inbound-handler.test.ts
 *
 * CS-5：`InboundHandler` 直接单测。
 *
 * 通过 `mock.module` 注入可控的 storage fake（仅 `saveContextToken`），并以 fake
 * state / typing / router / requestId / logger 逐条覆盖行为契约：
 * - 顺序：先生成 requestId → （contextToken 变化时）debug → 写 state → 失效 ticket
 *   → 条件持久化 → 最后 dispatch；
 * - contextToken 变化 + accountId/userId 齐全 → invalidateTicket、精确持久化、dispatch；
 * - contextToken 变化但凭证不全 → 更新 state + invalidateTicket、**不**持久化、仍 dispatch；
 * - context_token 缺失 / 空串 / 与当前相同 → 无任何副作用，仍 dispatch。
 */
import { test, expect, mock, beforeEach, setSystemTime } from "bun:test";
import { repoPath } from "../setup/mocks";
import type { WeixinMessage } from "../../src/ports/types.js";
import type { WechatApiOpts } from "../../src/shared/types.js";
import type { RequestIdGenerator } from "../../src/channel/request-id.js";
import type { PluginLogger } from "../../src/shared/logger.js";

// ---- storage fake（在 import InboundHandler 前安装） ----------------------

const saveContextToken = mock(async (_accountId: string, _userId: string, _entry: unknown) => {});

mock.module(repoPath("src", "storage", "state.js"), () => ({ saveContextToken }));

const { InboundHandler, createInboundHandler } = await import(
  "../../src/channel/inbound-handler.js"
);
const { ChannelState } = await import("../../src/channel/state.js");

// ---- fixtures --------------------------------------------------------------

const NOW = new Date("2026-01-02T03:04:05.678Z").getTime();
const OPTS: WechatApiOpts = { baseUrl: "https://ilinkai.example.com", token: "bot-token-abc" };
const NEW_CTX = "CTX-NEW";
const OLD_CTX = "CTX-OLD";

function makeLogger(order: string[]) {
  return {
    debug: mock((_message: string) => {
      order.push("debug");
    }),
    info: mock((_message: string) => {}),
    warn: mock((_message: string) => {}),
    error: mock((_message: string) => {}),
    child: mock((): unknown => makeLogger(order)),
  };
}

function makeHarness(overrides: Partial<ChannelState> = {}) {
  const order: string[] = [];
  const state = new ChannelState();
  Object.assign(state, overrides);

  const typing = {
    invalidateTicket: mock(() => {
      order.push("invalidateTicket");
    }),
  };
  const dispatch = mock(
    async (_msg: WeixinMessage, _requestId: string, _opts: WechatApiOpts) => {
      order.push("dispatch");
    },
  );
  const next = mock((_now?: number) => {
    order.push("requestId");
    return "REQ-1";
  });
  const logger = makeLogger(order);

  // 记录持久化调用顺序（覆盖 beforeEach 的默认空实现）
  saveContextToken.mockImplementation(async () => {
    order.push("saveContextToken");
  });

  const handler = new InboundHandler({
    state,
    typing,
    router: { dispatch },
    requestId: { next } as unknown as RequestIdGenerator,
    logger: logger as unknown as PluginLogger,
  });

  return { handler, state, typing, dispatch, next, logger, order };
}

beforeEach(() => {
  saveContextToken.mockReset();
  saveContextToken.mockImplementation(async () => {});
});

// ---------------------------------------------------------------------------
// contextToken 变化
// ---------------------------------------------------------------------------

test("contextToken 变化 + accountId/userId 齐全：更新 state、失效 ticket、精确持久化、按序 dispatch", async () => {
  setSystemTime(new Date(NOW));
  try {
    const h = makeHarness({ contextToken: OLD_CTX, accountId: "acc1", userId: "U1" });
    const msg: WeixinMessage = { context_token: NEW_CTX, item_list: [] };

    await h.handler.handle(msg, OPTS);

    // state 更新 + ticket 失效 + debug 文案精确
    expect(h.state.contextToken).toBe(NEW_CTX);
    expect(h.typing.invalidateTicket).toHaveBeenCalledTimes(1);
    expect(h.logger.debug).toHaveBeenCalledTimes(1);
    expect(h.logger.debug).toHaveBeenCalledWith("Updating contextToken from message");

    // 持久化以精确参数调用（含 displayName=userId、lastMessageAt=注入时钟）
    expect(saveContextToken).toHaveBeenCalledTimes(1);
    expect(saveContextToken).toHaveBeenCalledWith("acc1", "U1", {
      displayName: "U1",
      contextToken: NEW_CTX,
      lastMessageAt: NOW,
    });

    // requestId 生成一次，且 dispatch 收到生成的 id 与 opts
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);

    // 顺序契约：requestId → debug → invalidateTicket → saveContextToken → dispatch
    expect(h.order).toEqual([
      "requestId",
      "debug",
      "invalidateTicket",
      "saveContextToken",
      "dispatch",
    ]);
  } finally {
    setSystemTime();
  }
});

test("contextToken 变化但 accountId/userId 缺失：更新 state + 失效 ticket，不持久化，仍 dispatch", async () => {
  // accountId 存在、userId 缺失，验证「二者齐全」的与语义
  const h = makeHarness({ contextToken: OLD_CTX, accountId: "acc1", userId: null });
  const msg: WeixinMessage = { context_token: NEW_CTX, item_list: [] };

  await h.handler.handle(msg, OPTS);

  expect(h.state.contextToken).toBe(NEW_CTX);
  expect(h.typing.invalidateTicket).toHaveBeenCalledTimes(1);
  expect(saveContextToken).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);
  expect(h.order).toEqual(["requestId", "debug", "invalidateTicket", "dispatch"]);
});

test("contextToken 变化但 accountId 缺失：同样只更新 state + 失效 ticket，不持久化", async () => {
  const h = makeHarness({ contextToken: OLD_CTX, accountId: null, userId: "U1" });
  const msg: WeixinMessage = { context_token: NEW_CTX, item_list: [] };

  await h.handler.handle(msg, OPTS);

  expect(h.state.contextToken).toBe(NEW_CTX);
  expect(h.typing.invalidateTicket).toHaveBeenCalledTimes(1);
  expect(saveContextToken).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);
});

// ---------------------------------------------------------------------------
// 无变化 / 缺失
// ---------------------------------------------------------------------------

test("context_token 缺失：无更新、无失效、无持久化、无 debug，仍 dispatch", async () => {
  const h = makeHarness({ contextToken: OLD_CTX, accountId: "acc1", userId: "U1" });
  const msg: WeixinMessage = { item_list: [] };

  await h.handler.handle(msg, OPTS);

  expect(h.state.contextToken).toBe(OLD_CTX);
  expect(h.typing.invalidateTicket).not.toHaveBeenCalled();
  expect(saveContextToken).not.toHaveBeenCalled();
  expect(h.logger.debug).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);
  expect(h.order).toEqual(["requestId", "dispatch"]);
});

test("context_token 为空串：视为缺失，无副作用，仍 dispatch", async () => {
  const h = makeHarness({ contextToken: OLD_CTX, accountId: "acc1", userId: "U1" });
  const msg: WeixinMessage = { context_token: "", item_list: [] };

  await h.handler.handle(msg, OPTS);

  expect(h.state.contextToken).toBe(OLD_CTX);
  expect(h.typing.invalidateTicket).not.toHaveBeenCalled();
  expect(saveContextToken).not.toHaveBeenCalled();
  expect(h.logger.debug).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);
});

test("context_token 与当前相同：无副作用，仍 dispatch", async () => {
  const h = makeHarness({ contextToken: OLD_CTX, accountId: "acc1", userId: "U1" });
  const msg: WeixinMessage = { context_token: OLD_CTX, item_list: [] };

  await h.handler.handle(msg, OPTS);

  expect(h.state.contextToken).toBe(OLD_CTX);
  expect(h.typing.invalidateTicket).not.toHaveBeenCalled();
  expect(saveContextToken).not.toHaveBeenCalled();
  expect(h.logger.debug).not.toHaveBeenCalled();
  expect(h.dispatch).toHaveBeenCalledWith(msg, "REQ-1", OPTS);
  expect(h.order).toEqual(["requestId", "dispatch"]);
});

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

test("工厂 createInboundHandler：返回 InboundHandler 且委托行为一致", async () => {
  const state = new ChannelState();
  state.contextToken = OLD_CTX;
  state.accountId = "acc1";
  state.userId = "U1";

  const typing = { invalidateTicket: mock(() => {}) };
  const dispatch = mock(async () => {});
  const handler = createInboundHandler({
    state,
    typing,
    router: { dispatch },
    requestId: { next: () => "REQ-F" } as unknown as RequestIdGenerator,
    logger: makeLogger([]) as unknown as PluginLogger,
  });
  const msg: WeixinMessage = { item_list: [] };

  expect(handler).toBeInstanceOf(InboundHandler);

  await handler.handle(msg, OPTS);

  expect(dispatch).toHaveBeenCalledWith(msg, "REQ-F", OPTS);
});
