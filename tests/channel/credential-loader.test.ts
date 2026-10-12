/**
 * tests/channel/credential-loader.test.ts
 *
 * CS-4：`CredentialLoader` 直接单测。
 *
 * 通过 `mock.module` 注入可控的 storage fake（`getSingleUserCredentials` /
 * `getSingleUserContextToken`）与 fake logger，逐条覆盖行为契约：
 * - 无凭证 → 返回 false、error 日志、state 未被改动、且短路不查 contextToken；
 * - 有凭证 + 有 contextToken → 返回 true，state.userId/accountId/contextToken 正确，debug 含 present；
 * - 有凭证 + 无 contextToken → 返回 true、state.contextToken=null、warn 被调用、debug 含 MISSING；
 * - 工厂 `createCredentialLoader` 返回可用的 loader。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { installBaseMocks, repoPath } from "../setup/mocks";
import type { PluginLogger } from "../../src/shared/logger.js";

installBaseMocks();

// ---- storage fake（在 import CredentialLoader 前安装） ----------------------

const getSingleUserCredentials = mock(
  async (): Promise<{ botToken: string; accountId: string; userId: string; baseUrl: string } | null> =>
    null,
);
const getSingleUserContextToken = mock(async (): Promise<string | null> => null);

mock.module(repoPath("src", "storage", "state.js"), () => ({
  getSingleUserCredentials,
  getSingleUserContextToken,
}));

const { CredentialLoader, createCredentialLoader } = await import(
  "../../src/channel/credential-loader.js"
);
const { ChannelState } = await import("../../src/channel/state.js");

// ---- logger fake -----------------------------------------------------------

function makeLogger() {
  return {
    debug: mock((_m: string) => {}),
    info: mock((_m: string) => {}),
    warn: mock((_m: string) => {}),
    error: mock((_m: string) => {}),
    child: mock((): unknown => makeLogger()),
  };
}

function makeLoader(state = new ChannelState()) {
  const logger = makeLogger();
  const loader = new CredentialLoader({ state, logger: logger as unknown as PluginLogger });
  return { loader, state, logger };
}

beforeEach(() => {
  getSingleUserCredentials.mockReset();
  getSingleUserCredentials.mockImplementation(async () => null);
  getSingleUserContextToken.mockReset();
  getSingleUserContextToken.mockImplementation(async () => null);
});

// ---------------------------------------------------------------------------

test("无凭证：返回 false、error 日志、state 未被改动、短路不查 contextToken", async () => {
  const { loader, state, logger } = makeLoader();

  const result = await loader.ensureSession();

  expect(result).toBe(false);
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith("No logged in account found");
  // 短路：无 credentials 时绝不读取 contextToken
  expect(getSingleUserContextToken).not.toHaveBeenCalled();
  // state 未被改动
  expect(state.userId).toBeNull();
  expect(state.accountId).toBeNull();
  expect(state.contextToken).toBeNull();
});

test("有凭证 + 有 contextToken：返回 true，state 写入正确，debug 含 present", async () => {
  getSingleUserCredentials.mockResolvedValue({
    botToken: "bot-token-abc",
    accountId: "acc1",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });
  getSingleUserContextToken.mockResolvedValue("CTX-1");

  const { loader, state, logger } = makeLoader();

  const result = await loader.ensureSession();

  expect(result).toBe(true);
  expect(state.userId).toBe("U1");
  expect(state.accountId).toBe("acc1");
  expect(state.contextToken).toBe("CTX-1");
  expect(getSingleUserContextToken).toHaveBeenCalledTimes(1);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.debug).toHaveBeenCalledTimes(1);
  expect(logger.debug).toHaveBeenCalledWith(
    "Single user initialized: userId=U1, contextToken=present",
  );
});

test("有凭证 + 无 contextToken：返回 true、state.contextToken=null、warn 被调用、debug 含 MISSING", async () => {
  getSingleUserCredentials.mockResolvedValue({
    botToken: "bot-token-abc",
    accountId: "acc1",
    userId: "U1",
    baseUrl: "https://ilinkai.example.com",
  });
  getSingleUserContextToken.mockResolvedValue(null);

  const { loader, state, logger } = makeLoader();

  const result = await loader.ensureSession();

  expect(result).toBe(true);
  expect(state.userId).toBe("U1");
  expect(state.accountId).toBe("acc1");
  expect(state.contextToken).toBeNull();
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith("No context token found, replies may fail");
  expect(logger.debug).toHaveBeenCalledTimes(1);
  expect(logger.debug).toHaveBeenCalledWith(
    "Single user initialized: userId=U1, contextToken=MISSING",
  );
});

test("工厂 createCredentialLoader：返回可用 loader，委托行为一致", async () => {
  getSingleUserCredentials.mockResolvedValue({
    botToken: "bot-token-abc",
    accountId: "acc2",
    userId: "U2",
    baseUrl: "https://ilinkai.example.com",
  });
  getSingleUserContextToken.mockResolvedValue("CTX-2");

  const state = new ChannelState();
  const logger = makeLogger();
  const loader = createCredentialLoader({ state, logger: logger as unknown as PluginLogger });

  expect(loader).toBeInstanceOf(CredentialLoader);
  expect(await loader.ensureSession()).toBe(true);
  expect(state.userId).toBe("U2");
  expect(state.accountId).toBe("acc2");
  expect(state.contextToken).toBe("CTX-2");
});
