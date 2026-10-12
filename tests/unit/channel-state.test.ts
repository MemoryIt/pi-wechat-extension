/**
 * tests/unit/channel-state.test.ts
 *
 * ChannelState：运行时会话状态的默认值、字段读写与 resetSession 语义。
 * resetSession 清空凭证 / 终端标志，保留 config / host / notifier。
 * （requestId 追踪已迁出到 `RequestIdGenerator`，其不变量由
 * `tests/channel/request-id.test.ts` 覆盖。）
 */
import { test, expect } from "bun:test";
import { ChannelState } from "../../src/channel/state.js";
import type { PiHost } from "../../src/ports/pi-host.js";

function fakeHost(): PiHost {
  return {
    appendEntry: () => {},
    sendUserMessage: () => {},
    sendMessage: () => {},
  };
}

test("ChannelState 默认值：凭证/依赖为空，终端标志 false", () => {
  const s = new ChannelState();
  expect(s.accountId).toBeNull();
  expect(s.userId).toBeNull();
  expect(s.contextToken).toBeNull();
  expect(s.config).toBeNull();
  expect(s.host).toBeNull();
  expect(s.notifier).toBeNull();
  expect(s.isTerminalMessageProcessing).toBe(false);
});

test("ChannelState 承载凭证/配置/宿主/通知与终端标志", () => {
  const s = new ChannelState();
  const host = fakeHost();
  const notifier = () => {};

  s.accountId = "acc1";
  s.userId = "U1";
  s.contextToken = "CTX";
  s.config = { baseUrl: "https://x", token: "t" };
  s.host = host;
  s.notifier = notifier;
  s.isTerminalMessageProcessing = true;

  expect(s.accountId).toBe("acc1");
  expect(s.userId).toBe("U1");
  expect(s.contextToken).toBe("CTX");
  expect(s.config).toEqual({ baseUrl: "https://x", token: "t" });
  expect(s.host).toBe(host);
  expect(s.notifier).toBe(notifier);
  expect(s.isTerminalMessageProcessing).toBe(true);
});

test("resetSession：清空凭证/终端标志，保留 config/host/notifier", () => {
  const s = new ChannelState();
  const host = fakeHost();
  const notifier = () => {};

  s.accountId = "acc1";
  s.userId = "U1";
  s.contextToken = "CTX";
  s.config = { baseUrl: "https://x", token: "t" };
  s.host = host;
  s.notifier = notifier;
  s.isTerminalMessageProcessing = true;

  s.resetSession();

  expect(s.accountId).toBeNull();
  expect(s.userId).toBeNull();
  expect(s.contextToken).toBeNull();
  expect(s.isTerminalMessageProcessing).toBe(false);

  // config/host/notifier 跨 resetSession 保留
  expect(s.config).toEqual({ baseUrl: "https://x", token: "t" });
  expect(s.host).toBe(host);
  expect(s.notifier).toBe(notifier);
});

test("resetSession 可重复调用且幂等", () => {
  const s = new ChannelState();
  s.resetSession();
  s.resetSession();
  expect(s.accountId).toBeNull();
  expect(s.userId).toBeNull();
  expect(s.contextToken).toBeNull();
  expect(s.isTerminalMessageProcessing).toBe(false);
});

test("getCredentials：config/userId/contextToken 齐备时组装凭证，缺一返回 null", () => {
  const s = new ChannelState();
  expect(s.getCredentials()).toBeNull();

  s.config = { baseUrl: "https://x", token: "t" };
  expect(s.getCredentials()).toBeNull();

  s.userId = "U1";
  expect(s.getCredentials()).toBeNull();

  s.contextToken = "CTX";
  expect(s.getCredentials()).toEqual({
    baseUrl: "https://x",
    token: "t",
    userId: "U1",
    contextToken: "CTX",
  });
});

test("getOpts：有 config 时返回 baseUrl/token，否则 null", () => {
  const s = new ChannelState();
  expect(s.getOpts()).toBeNull();

  s.config = { baseUrl: "https://x", token: "t" };
  expect(s.getOpts()).toEqual({ baseUrl: "https://x", token: "t" });
});
