/**
 * tests/unit/channel-state.test.ts
 *
 * ChannelState：运行时会话状态的默认值、字段读写与 resetSession 语义。
 * resetSession 清空凭证 / 终端标志 / 请求追踪，保留 config / host / notifier。
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

test("ChannelState 默认值：凭证/依赖为空，终端标志 false，请求追踪初始", () => {
  const s = new ChannelState();
  expect(s.accountId).toBeNull();
  expect(s.userId).toBeNull();
  expect(s.contextToken).toBeNull();
  expect(s.config).toBeNull();
  expect(s.host).toBeNull();
  expect(s.notifier).toBeNull();
  expect(s.isTerminalMessageProcessing).toBe(false);
  expect(s.lastRequestIdMs).toBe(-1);
  expect(s.requestIdSeq).toBe(0);
});

test("ChannelState 承载凭证/配置/宿主/通知与请求追踪", () => {
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
  s.lastRequestIdMs = 123;
  s.requestIdSeq = 7;

  expect(s.accountId).toBe("acc1");
  expect(s.userId).toBe("U1");
  expect(s.contextToken).toBe("CTX");
  expect(s.config).toEqual({ baseUrl: "https://x", token: "t" });
  expect(s.host).toBe(host);
  expect(s.notifier).toBe(notifier);
  expect(s.isTerminalMessageProcessing).toBe(true);
  expect(s.lastRequestIdMs).toBe(123);
  expect(s.requestIdSeq).toBe(7);
});

test("resetSession：清空凭证/终端标志/请求计数，保留 config/host/notifier", () => {
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
  s.lastRequestIdMs = 999;
  s.requestIdSeq = 42;

  s.resetSession();

  expect(s.accountId).toBeNull();
  expect(s.userId).toBeNull();
  expect(s.contextToken).toBeNull();
  expect(s.isTerminalMessageProcessing).toBe(false);
  expect(s.lastRequestIdMs).toBe(-1);
  expect(s.requestIdSeq).toBe(0);

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
  expect(s.lastRequestIdMs).toBe(-1);
  expect(s.requestIdSeq).toBe(0);
});
