/**
 * tests/unit/storage.test.ts
 *
 * 覆盖缺陷 D12（存储非原子 / read-modify-write 丢写）以及附带验证 D10
 * （getSingleUserContextToken 取第一个 key，不绑定 token.userId）。
 */
import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { installBaseMocks, agentDir, resetAgentDir, wechatDataDir } from "../setup/mocks";

installBaseMocks();

const storage = await import("../../storage/state.js");

function tokenFixture(overrides: Record<string, unknown> = {}) {
  return {
    botToken: "bot-token-xyz",
    accountId: "acc1",
    userId: "U1",
    baseUrl: "https://ilinkai.weixin.qq.com",
    loginAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  resetAgentDir();
});

// ---------------------------------------------------------------------------
// 基线：token 往返 + 权限
// ---------------------------------------------------------------------------

test("基线：saveToken/loadToken 往返，且 token.json 权限为 600", async () => {
  const token = tokenFixture();
  await storage.saveToken("acc1", token);

  const loaded = await storage.loadToken("acc1");
  expect(loaded).toEqual(token);

  const tokenPath = join(wechatDataDir(), "accounts", "acc1", "token.json");
  expect(existsSync(tokenPath)).toBe(true);
  expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
});

test("基线：损坏的 JSON 返回 null 而不是抛错", async () => {
  const dir = join(wechatDataDir(), "accounts", "acc1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token.json"), "{ this is not json", "utf-8");

  expect(await storage.loadToken("acc1")).toBeNull();
});

// ---------------------------------------------------------------------------
// D12：并发 saveContextToken 的 read-modify-write 丢写
// ---------------------------------------------------------------------------

test("D12 证伪：并发写入不同用户的 contextToken 会丢失其中一条", async () => {
  await storage.saveContextToken("acc1", "u1", { displayName: "u1", contextToken: "t1" });

  await Promise.all([
    storage.saveContextToken("acc1", "u2", { displayName: "u2", contextToken: "t2" }),
    storage.saveContextToken("acc1", "u3", { displayName: "u3", contextToken: "t3" }),
  ]);

  const tokens = await storage.loadContextTokens("acc1");
  // 旧行为：u2/u3 各读到 {u1}，后写覆盖前写，最终只保留 u1 + 其中一条。
  expect(Object.keys(tokens).length).toBe(2);
});

test.failing("D12 目标：并发写入不同用户的 contextToken 不应丢写", async () => {
  await storage.saveContextToken("acc1", "u1", { displayName: "u1", contextToken: "t1" });

  await Promise.all([
    storage.saveContextToken("acc1", "u2", { displayName: "u2", contextToken: "t2" }),
    storage.saveContextToken("acc1", "u3", { displayName: "u3", contextToken: "t3" }),
  ]);

  const tokens = await storage.loadContextTokens("acc1");
  expect(Object.keys(tokens).sort()).toEqual(["u1", "u2", "u3"]);
});

// ---------------------------------------------------------------------------
// D10：getSingleUserContextToken 未绑定 token.userId，返回了错误用户
// ---------------------------------------------------------------------------

test("D10 证伪：getSingleUserContextToken 返回了非 token.userId 的用户 token", async () => {
  await storage.saveToken("acc1", tokenFixture({ userId: "U1" }));
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });

  // 故意先写 U2，使 Object.keys 顺序为 U2, U1。
  await storage.saveContextToken("acc1", "U2", { displayName: "U2", contextToken: "TOK-U2" });
  await storage.saveContextToken("acc1", "U1", { displayName: "U1", contextToken: "TOK-U1" });

  expect(await storage.getSingleUserContextToken()).toBe("TOK-U2");
});

test.failing("D10 目标：getSingleUserContextToken 应返回 token.userId 对应的 token", async () => {
  await storage.saveToken("acc1", tokenFixture({ userId: "U1" }));
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });

  await storage.saveContextToken("acc1", "U2", { displayName: "U2", contextToken: "TOK-U2" });
  await storage.saveContextToken("acc1", "U1", { displayName: "U1", contextToken: "TOK-U1" });

  expect(await storage.getSingleUserContextToken()).toBe("TOK-U1");
});

// ---------------------------------------------------------------------------
// 基线：账号索引与删除
// ---------------------------------------------------------------------------

test("基线：getDefaultAccountToken 返回最近登录的账号", async () => {
  await storage.saveToken("old", tokenFixture({ accountId: "old", userId: "OLD" }));
  await storage.saveToken("new", tokenFixture({ accountId: "new", userId: "NEW" }));
  await storage.upsertAccount({ accountId: "old", displayName: "old", loginAt: 1000 });
  await storage.upsertAccount({ accountId: "new", displayName: "new", loginAt: 2000 });

  const token = await storage.getDefaultAccountToken();
  expect(token?.accountId).toBe("new");
});

test("基线：deleteAccountData 删除整个账号目录", async () => {
  await storage.saveToken("acc1", tokenFixture());
  await storage.deleteAccountData("acc1");
  expect(existsSync(join(wechatDataDir(), "accounts", "acc1"))).toBe(false);
});
