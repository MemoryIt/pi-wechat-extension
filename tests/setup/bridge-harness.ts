/**
 * tests/setup/bridge-harness.ts
 *
 * L3 事件桥接夹具：探针型假 ExtensionAPI + 假 `Channel`（Channel API）+ 可控 auth fake。
 * `loadExtension({ channel, auth })` 通过 `src/index.ts` 的 `createExtension` 注入
 * fake，不再 mock 引擎单例模块。
 */
import { mock } from "bun:test";
import { installBaseMocks } from "./mocks";
import { createFakePi } from "./fake-pi";
import type { Channel } from "../../src/channel/channel.js";
import type { WechatAuth } from "../../src/ports/auth.js";

// ---- 假 Channel（带真实去重语义，便于验证 agent_settled 相关行为）--------

export interface BridgeChannel {
  connectionState: string;
  _terminal: boolean;
  _processed: Set<string>;
  setHost: ReturnType<typeof mock>;
  setConfig: ReturnType<typeof mock>;
  setNotifier: ReturnType<typeof mock>;
  setTerminalProcessing: ReturnType<typeof mock>;
  getTerminalProcessing: ReturnType<typeof mock>;
  startPolling: ReturnType<typeof mock>;
  stopPolling: ReturnType<typeof mock>;
  reset: ReturnType<typeof mock>;
  startTyping: ReturnType<typeof mock>;
  stopTyping: ReturnType<typeof mock>;
  onAiDone: ReturnType<typeof mock>;
  isRequestProcessed: ReturnType<typeof mock>;
  markRequestProcessed: ReturnType<typeof mock>;
  sendReply: ReturnType<typeof mock>;
  sendFile: ReturnType<typeof mock>;
}

export function createBridgeChannel(): BridgeChannel {
  const processed = new Set<string>();
  const channel: BridgeChannel = {
    connectionState: "disconnected",
    _terminal: false,
    _processed: processed,
    setHost: mock(() => {}),
    setConfig: mock(() => {}),
    setNotifier: mock(() => {}),
    setTerminalProcessing: mock((v: boolean) => {
      channel._terminal = v;
    }),
    getTerminalProcessing: mock(() => channel._terminal),
    startPolling: mock(async () => {}),
    stopPolling: mock(() => {}),
    reset: mock(() => {}),
    startTyping: mock(async () => {}),
    stopTyping: mock(async () => {}),
    onAiDone: mock(() => {}),
    isRequestProcessed: mock((id: string) => processed.has(id)),
    markRequestProcessed: mock((id: string) => {
      processed.add(id);
    }),
    sendReply: mock(async () => {}),
    sendFile: mock(async () => {}),
  };
  return channel;
}

export function resetBridgeChannel(channel: BridgeChannel): void {
  channel._terminal = false;
  channel._processed.clear();
  for (const key of [
    "setHost",
    "setConfig",
    "setNotifier",
    "setTerminalProcessing",
    "getTerminalProcessing",
    "startPolling",
    "stopPolling",
    "reset",
    "startTyping",
    "stopTyping",
    "onAiDone",
    "isRequestProcessed",
    "markRequestProcessed",
    "sendReply",
    "sendFile",
  ] as const) {
    (channel as unknown as Record<string, { mockClear: () => void }>)[key].mockClear();
  }
}

// ---- auth fake ------------------------------------------------------------

export const authMock = {
  startQr: mock(async () => ({
    qrcodeUrl: "https://ilinkai.example.com/qr",
    sessionKey: "session-key-1",
    message: "ok",
  })),
  waitForLogin: mock(async () => ({ connected: false, message: "" })),
};

export function resetAuthMock(): void {
  authMock.startQr.mockReset();
  authMock.startQr.mockImplementation(async () => ({
    qrcodeUrl: "https://ilinkai.example.com/qr",
    sessionKey: "session-key-1",
    message: "ok",
  }));
  authMock.waitForLogin.mockReset();
  authMock.waitForLogin.mockImplementation(async () => ({ connected: false, message: "" }));
}

// ---- 模块加载 --------------------------------------------------------------

/** 安装基础 mock 并用注入的 fake 组装扩展，返回 `(pi) => void` 注册函数。 */
export async function loadExtension(deps: {
  channel: BridgeChannel;
  auth: typeof authMock;
}): Promise<(pi: unknown) => void> {
  installBaseMocks();
  const mod = await import("../../src/index.ts");
  return mod.createExtension({
    channel: deps.channel as unknown as Channel,
    auth: deps.auth as unknown as WechatAuth,
  }) as (pi: unknown) => void;
}

export { createFakePi };
