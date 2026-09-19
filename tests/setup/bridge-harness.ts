/**
 * tests/setup/bridge-harness.ts
 *
 * L3 事件桥接夹具：探针型假 ExtensionAPI + 假 engine + 可控 auth mock。
 * 在导入 index.ts 之前调用 installBridgeMocks()。
 */
import { mock } from "bun:test";
import { installBaseMocks, repoPath } from "./mocks";
import { createFakePi } from "./fake-pi";

// ---- 假 engine（带真实去重语义，便于验证 agent_end 相关行为）---------------

export interface BridgeEngine {
  connectionState: string;
  _terminal: boolean;
  _processed: Set<string>;
  setNotifier: ReturnType<typeof mock>;
  setTerminalProcessing: ReturnType<typeof mock>;
  getTerminalProcessing: ReturnType<typeof mock>;
  startPolling: ReturnType<typeof mock>;
  stopPolling: ReturnType<typeof mock>;
  reset: ReturnType<typeof mock>;
  startTypingKeepalive: ReturnType<typeof mock>;
  stopTypingKeepalive: ReturnType<typeof mock>;
  onAiDone: ReturnType<typeof mock>;
  isRequestProcessed: ReturnType<typeof mock>;
  markRequestProcessed: ReturnType<typeof mock>;
  sendMessageWithRetry: ReturnType<typeof mock>;
  sendFileToUser: ReturnType<typeof mock>;
}

export function createBridgeEngine(): BridgeEngine {
  const processed = new Set<string>();
  const engine: BridgeEngine = {
    connectionState: "disconnected",
    _terminal: false,
    _processed: processed,
    setNotifier: mock(() => {}),
    setTerminalProcessing: mock((v: boolean) => {
      engine._terminal = v;
    }),
    getTerminalProcessing: mock(() => engine._terminal),
    startPolling: mock(async () => {}),
    stopPolling: mock(() => {}),
    reset: mock(() => {}),
    startTypingKeepalive: mock(async () => {}),
    stopTypingKeepalive: mock(async () => {}),
    onAiDone: mock(() => {}),
    isRequestProcessed: mock((id: string) => processed.has(id)),
    markRequestProcessed: mock((id: string) => {
      processed.add(id);
    }),
    sendMessageWithRetry: mock(async () => {}),
    sendFileToUser: mock(async () => {}),
  };
  return engine;
}

export function resetBridgeEngine(engine: BridgeEngine): void {
  engine._terminal = false;
  engine._processed.clear();
  for (const key of [
    "setNotifier",
    "setTerminalProcessing",
    "getTerminalProcessing",
    "startPolling",
    "stopPolling",
    "reset",
    "startTypingKeepalive",
    "stopTypingKeepalive",
    "onAiDone",
    "isRequestProcessed",
    "markRequestProcessed",
    "sendMessageWithRetry",
    "sendFileToUser",
  ] as const) {
    (engine as unknown as Record<string, { mockClear: () => void }>)[key].mockClear();
  }
}

// ---- auth mock ------------------------------------------------------------

export const authMock = {
  startWeixinLoginWithQr: mock(async () => ({
    qrcodeUrl: "https://ilinkai.example.com/qr",
    sessionKey: "session-key-1",
    message: "ok",
  })),
  waitForWeixinLogin: mock(async () => ({ connected: false })),
  DEFAULT_ILINK_BOT_TYPE: "test-bot-type",
};

export function resetAuthMock(): void {
  authMock.startWeixinLoginWithQr.mockReset();
  authMock.startWeixinLoginWithQr.mockImplementation(async () => ({
    qrcodeUrl: "https://ilinkai.example.com/qr",
    sessionKey: "session-key-1",
    message: "ok",
  }));
  authMock.waitForWeixinLogin.mockReset();
  authMock.waitForWeixinLogin.mockImplementation(async () => ({ connected: false }));
}

// ---- setConfig mock（wechat.js 导出）-------------------------------------

export const setConfigMock = mock((_cfg: unknown) => {});
export const setPiMock = mock((_pi: unknown) => {});

// ---- mock 安装 / 模块加载 --------------------------------------------------

let installed = false;

export function installBridgeMocks(engine: BridgeEngine): void {
  installBaseMocks();
  if (installed) return;
  installed = true;

  const wechatModule = () => ({
    engine,
    setPi: setPiMock,
    setConfig: setConfigMock,
  });
  mock.module(repoPath("src", "engine", "wechat.js"), wechatModule);
  mock.module(repoPath("src", "engine", "wechat.ts"), wechatModule);

  const authModule = () => ({
    startWeixinLoginWithQr: authMock.startWeixinLoginWithQr,
    waitForWeixinLogin: authMock.waitForWeixinLogin,
    DEFAULT_ILINK_BOT_TYPE: authMock.DEFAULT_ILINK_BOT_TYPE,
  });
  mock.module(repoPath("auth", "login-qr.js"), authModule);
  mock.module(repoPath("auth", "login-qr.ts"), authModule);
}

export async function loadIndex() {
  const mod = await import("../../src/index.ts");
  return mod.default as (pi: unknown) => void;
}

export { createFakePi };
