/**
 * tests/application/session.test.ts
 *
 * L1a：`SessionService` 会话生命周期用例（fake SessionChannel + fake auth +
 * fake SessionUi + 真实 storage + 临时 agent dir）。
 * 覆盖 rf-2 行为契约：
 *   - start：有 token → setConfig + startPolling + 文案；无 token → 错误文案、不启动
 *   - startFromStoredToken：有/无 token 两路
 *   - status：登录/未登录两路文案
 *   - stop：stopPolling + 文案
 *   - logout：reset + 删除账户 + 文案；未登录文案
 *   - login 成功：saveToken/upsertAccount/setConfig/startPolling + 成功文案 + 摘要不出现明文 token
 *   - login 未 connected：失败文案
 *   - shutdown：stopPolling + reset
 *   - 轮询失败路径：start / login / startFromStoredToken 三种错误提示
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { installBaseMocks, resetAgentDir } from "../setup/mocks";
import type { SessionChannel, SessionService, SessionUi } from "../../src/application/session.js";
import type { PluginLogger } from "../../src/shared/logger.js";
import type { WechatAuth } from "../../src/ports/auth.js";

installBaseMocks();

const sessionMod = await import("../../src/application/session.js");
const storage = await import("../../src/storage/state.js");

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface RecordEntry {
  level: string;
  message: string;
  args: unknown[];
}

function recordingLogger(): { logger: PluginLogger; records: RecordEntry[] } {
  const records: RecordEntry[] = [];
  const make =
    (level: string) =>
    (message: string, ...args: unknown[]): void => {
      records.push({ level, message, args });
    };
  const logger = {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: (): PluginLogger => logger,
  };
  return { logger, records };
}

interface FakeChannelBox {
  channel: SessionChannel;
  order: string[];
}

function createFakeChannel(connectionState = "connected"): FakeChannelBox {
  const order: string[] = [];
  const channel: SessionChannel = {
    connectionState,
    setConfig: mock(() => {
      order.push("setConfig");
    }),
    startPolling: mock(async () => {
      order.push("startPolling");
    }),
    stopPolling: mock(() => {
      order.push("stopPolling");
    }),
    reset: mock(() => {
      order.push("reset");
    }),
  };
  return { channel, order };
}

function createFakeAuth(): WechatAuth {
  return {
    startQr: mock(async () => ({
      qrcodeUrl: "https://ilinkai.example.com/qr",
      sessionKey: "session-key-1",
      message: "ok",
    })),
    waitForLogin: mock(async () => ({ connected: false, message: "login timeout" })),
  };
}

interface FakeUiBox {
  ui: SessionUi;
  notified: Array<[string, string | undefined]>;
  logged: string[];
  qrShown: string[];
}

function createFakeUi(order?: string[]): FakeUiBox {
  const notified: Array<[string, string | undefined]> = [];
  const logged: string[] = [];
  const qrShown: string[] = [];
  const ui: SessionUi = {
    notify: mock((message: string, type?: "info" | "warning" | "error") => {
      order?.push(`notify:${message}`);
      notified.push([message, type]);
    }),
    log: mock((message: string) => {
      logged.push(message);
    }),
    showQr: mock((qrcodeUrl: string) => {
      qrShown.push(qrcodeUrl);
    }),
  };
  return { ui, notified, logged, qrShown };
}

/** 往真实 storage 种一个已登录账号。 */
async function seedToken(): Promise<void> {
  await storage.saveToken("acc1", {
    botToken: "bot-token-abc",
    accountId: "acc1",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
    loginAt: Date.now(),
  });
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });
}

const { SessionService } = sessionMod;

beforeEach(() => {
  resetAgentDir();
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// /wechat start
// ---------------------------------------------------------------------------

test("start：有 token → setConfig → 文案 → startPolling", async () => {
  await seedToken();
  const { channel, order } = createFakeChannel();
  const { ui, notified } = createFakeUi(order);
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.start(ui);

  expect(notified).toContainEqual(["WeChat: Starting polling...", "info"]);
  const idxSetConfig = order.indexOf("setConfig");
  const idxNotify = order.indexOf("notify:WeChat: Starting polling...");
  const idxStartPolling = order.indexOf("startPolling");
  expect(idxSetConfig).toBeGreaterThanOrEqual(0);
  expect(idxStartPolling).toBeGreaterThanOrEqual(0);
  expect(idxSetConfig).toBeLessThan(idxNotify);
  expect(idxNotify).toBeLessThan(idxStartPolling);
});

test("start：startPolling 失败 → notify Polling error", async () => {
  await seedToken();
  const { channel } = createFakeChannel();
  (channel.startPolling as ReturnType<typeof mock>).mockRejectedValue(new Error("boom"));
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.start(ui);
  await tick();

  expect(notified).toContainEqual(["Polling error: boom", "error"]);
  expect(channel.setConfig).toHaveBeenCalledTimes(1);
  expect(channel.startPolling).toHaveBeenCalledTimes(1);
});

test("start：无 token → 错误文案、不启动", async () => {
  const { channel } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.start(ui);

  expect(notified).toContainEqual(["WeChat: Not logged in. Use /wechat login first.", "error"]);
  expect(channel.setConfig).not.toHaveBeenCalled();
  expect(channel.startPolling).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// session_start：startFromStoredToken
// ---------------------------------------------------------------------------

test("startFromStoredToken：有 token → setConfig + startPolling", async () => {
  await seedToken();
  const { channel } = createFakeChannel();
  const { ui } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.startFromStoredToken(ui);

  expect(channel.setConfig).toHaveBeenCalledWith({
    baseUrl: "https://ilinkai.example.com",
    token: "bot-token-abc",
  });
  expect(channel.startPolling).toHaveBeenCalledWith({
    baseUrl: "https://ilinkai.example.com",
    token: "bot-token-abc",
  });
});

test("startFromStoredToken：startPolling 失败 → logger.error('Polling error:', msg)", async () => {
  await seedToken();
  const { channel } = createFakeChannel();
  (channel.startPolling as ReturnType<typeof mock>).mockRejectedValue(new Error("boom"));
  const { ui } = createFakeUi();
  const { logger, records } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.startFromStoredToken(ui);
  await tick();

  expect(records.some((r) => r.level === "error" && r.message === "Polling error:" && r.args[0] === "boom")).toBe(true);
});

test("startFromStoredToken：无 token → 不启动、仅 debug", async () => {
  const { channel } = createFakeChannel();
  const { ui } = createFakeUi();
  const { logger, records } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.startFromStoredToken(ui);

  expect(channel.setConfig).not.toHaveBeenCalled();
  expect(channel.startPolling).not.toHaveBeenCalled();
  expect(records.some((r) => r.level === "debug" && r.message === "session_start: no logged in account found")).toBe(true);
});

// ---------------------------------------------------------------------------
// /wechat status
// ---------------------------------------------------------------------------

test("status：已登录 → 登录摘要 + 连接状态", async () => {
  await seedToken();
  const { channel } = createFakeChannel("connecting");
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.status(ui);

  expect(notified).toContainEqual([
    "WeChat: Logged in\nUser ID: U1\nConnection: connecting",
    "info",
  ]);
});

test("status：未登录 → WeChat: Not logged in", async () => {
  const { channel } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.status(ui);

  expect(notified).toContainEqual(["WeChat: Not logged in", "info"]);
});

// ---------------------------------------------------------------------------
// /wechat stop
// ---------------------------------------------------------------------------

test("stop：stopPolling + 文案", () => {
  const { channel, order } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  service.stop(ui);

  expect(channel.stopPolling).toHaveBeenCalledTimes(1);
  expect(notified).toContainEqual(["WeChat: Stopped polling", "info"]);
  expect(order).toEqual(["stopPolling"]);
});

// ---------------------------------------------------------------------------
// /wechat logout
// ---------------------------------------------------------------------------

test("logout：reset → 删除账户数据 → 文案", async () => {
  await seedToken();
  const { channel, order } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.logout(ui);

  expect(order[0]).toBe("reset");
  expect(notified).toContainEqual(["WeChat: Logged out successfully", "info"]);
  // 真实 storage 断言：token 与账号索引都被删除
  expect(await storage.getDefaultAccountToken()).toBeNull();
  expect(await storage.listAccounts()).toEqual([]);
});

test("logout：未登录 → reset + Not logged in 文案", async () => {
  const { channel, order } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  await service.logout(ui);

  expect(channel.reset).toHaveBeenCalledTimes(1);
  expect(notified).toContainEqual(["WeChat: Not logged in", "info"]);
  expect(order).toEqual(["reset"]);
});

// ---------------------------------------------------------------------------
// /wechat login
// ---------------------------------------------------------------------------

test("login 成功：saveToken/upsertAccount → setConfig → startPolling → 成功文案 + 脱敏摘要", async () => {
  const auth = createFakeAuth();
  (auth.waitForLogin as ReturnType<typeof mock>).mockResolvedValue({
    connected: true,
    message: "ok",
    accountId: "acc1",
    botToken: "SECRET-BOT-TOKEN",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });
  const { channel, order } = createFakeChannel();
  const { ui, notified, logged, qrShown } = createFakeUi(order);
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth, logger });

  await service.login(ui);

  // 二维码展示
  expect(qrShown).toEqual(["https://ilinkai.example.com/qr"]);
  expect(notified[0]).toEqual(["请使用微信扫描二维码...", "info"]);
  // 持久化（真实 storage）
  const saved = await storage.getDefaultAccountToken();
  expect(saved?.botToken).toBe("SECRET-BOT-TOKEN");
  expect(await storage.listAccounts()).toHaveLength(1);
  // 成功文案 + 启动轮询（✅ 在 setConfig 之前）
  expect(notified).toContainEqual(["✅ 与微信连接成功！", "info"]);
  expect(order.indexOf("notify:✅ 与微信连接成功！")).toBeLessThan(order.indexOf("setConfig"));
  expect(order.indexOf("setConfig")).toBeLessThan(order.indexOf("startPolling"));
  // 摘要不出现明文 token（D11）
  expect(logged.join("\n")).toContain("=== 登录成功 ===");
  expect(logged.join("\n")).not.toContain("SECRET-BOT-TOKEN");
});

test("login 成功：startPolling 失败 → notify 启动轮询失败", async () => {
  const auth = createFakeAuth();
  (auth.waitForLogin as ReturnType<typeof mock>).mockResolvedValue({
    connected: true,
    message: "ok",
    accountId: "acc1",
    botToken: "SECRET-BOT-TOKEN",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });
  const { channel } = createFakeChannel();
  (channel.startPolling as ReturnType<typeof mock>).mockRejectedValue(new Error("boom"));
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth, logger });

  await service.login(ui);
  await tick();

  expect(notified).toContainEqual(["启动轮询失败: boom", "error"]);
});

test("login 未 connected → 失败文案、不保存、不启动", async () => {
  const auth = createFakeAuth();
  (auth.waitForLogin as ReturnType<typeof mock>).mockResolvedValue({
    connected: false,
    message: "user cancelled",
  });
  const { channel } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth, logger });

  await service.login(ui);

  expect(notified).toContainEqual(["登录失败: user cancelled", "error"]);
  expect(await storage.listAccounts()).toEqual([]);
  expect(channel.setConfig).not.toHaveBeenCalled();
  expect(channel.startPolling).not.toHaveBeenCalled();
});

test("login startQr 无 qrcodeUrl → Failed to get QR code", async () => {
  const auth = createFakeAuth();
  (auth.startQr as ReturnType<typeof mock>).mockResolvedValue({
    qrcodeUrl: undefined,
    sessionKey: "session-key-1",
    message: "qr unavailable",
  });
  const { channel } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth, logger });

  await service.login(ui);

  expect(notified).toContainEqual(["Failed to get QR code: qr unavailable", "error"]);
  expect(channel.startPolling).not.toHaveBeenCalled();
});

test("login 外层异常 → debug + 登录异常文案", async () => {
  const auth = createFakeAuth();
  (auth.startQr as ReturnType<typeof mock>).mockRejectedValue(new Error("boom"));
  const { channel } = createFakeChannel();
  const { ui, notified } = createFakeUi();
  const { logger, records } = recordingLogger();
  const service = new SessionService({ channel, auth, logger });

  await service.login(ui);

  expect(notified).toContainEqual(["登录异常: Error: boom", "error"]);
  expect(records.some((r) => r.level === "debug" && r.message === "performWechatLogin failed:")).toBe(true);
});

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

test("shutdown：stopPolling + reset", () => {
  const { channel, order } = createFakeChannel();
  const { logger } = recordingLogger();
  const service = new SessionService({ channel, auth: createFakeAuth(), logger });

  service.shutdown();

  expect(order).toEqual(["stopPolling", "reset"]);
});