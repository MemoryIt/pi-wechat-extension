/**
 * tests/channel/typing.test.ts
 *
 * L2：直接测试 `src/channel/typing.ts` 的 `TypingController`。
 *
 * 由原 `channel.test.ts` D16 的 3 例迁移而来（原用例经 `Channel` 公共转发方法
 * `getTypingTicket` / `sendTypingStatus` 观测；这些转发方法已随 CS-7 从 facade 删除）。
 * 这里注入 fake `outbound` 与 `getContextToken`，直接覆盖三条语义：
 * - ticket 缓存绑定 contextToken，token 变化后旧 ticket 失效（原 D16-1）。
 * - ticket 缓存 60s TTL 内命中、过期后重新获取（原 D16-2，沿用 `Date.now` 覆盖手法）。
 * - `sendTyping` 报错含 "ticket" 时清空缓存并重新获取（原 D16-3）。
 *
 * 断言强度不低于原用例（精确 `toBe` / `toHaveBeenCalledWith` / `toHaveBeenCalledTimes`）。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { TypingController } from "../../src/channel/typing.js";

function makeTyping() {
  const outbound = {
    sendText: mock(async (_text: string) => {}),
    sendFile: mock(async (_localPath: string) => {}),
    sendTyping: mock(async (_status: 1 | 2, _ticket: string) => {}),
    getTypingTicket: mock(async () => "TICKET-1" as string | null),
  };
  let contextToken: string | null = "CTX-1";
  const controller = new TypingController({
    outbound,
    getContextToken: () => contextToken,
    debug: () => {},
    error: () => {},
  });
  return {
    outbound,
    controller,
    setContextToken(token: string | null) {
      contextToken = token;
    },
  };
}

let typing: ReturnType<typeof makeTyping>;

beforeEach(() => {
  typing = makeTyping();
});

test("typing：contextToken 变化后应重新获取 ticket（原 D16-1）", async () => {
  typing.outbound.getTypingTicket.mockResolvedValue("T1");

  const t1 = await typing.controller.getTicket();
  expect(t1).toBe("T1");

  typing.setContextToken("CTX-NEW");
  typing.outbound.getTypingTicket.mockResolvedValue("T2");

  const t2 = await typing.controller.getTicket();
  expect(t2).toBe("T2");
  expect(typing.outbound.getTypingTicket).toHaveBeenCalledTimes(2);
});

test("typing：ticket 缓存 60s TTL 内命中、过期后重新获取（原 D16-2）", async () => {
  typing.outbound.getTypingTicket.mockResolvedValue("T1");

  expect(await typing.controller.getTicket()).toBe("T1");
  // TTL 内命中缓存
  expect(await typing.controller.getTicket()).toBe("T1");
  expect(typing.outbound.getTypingTicket).toHaveBeenCalledTimes(1);

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    typing.outbound.getTypingTicket.mockResolvedValue("T2");
    expect(await typing.controller.getTicket()).toBe("T2");
  } finally {
    Date.now = realNow;
  }
  expect(typing.outbound.getTypingTicket).toHaveBeenCalledTimes(2);
});

test("typing：sendStatus 报错含 'ticket' 时清空缓存并重新获取（原 D16-3）", async () => {
  typing.outbound.getTypingTicket.mockResolvedValue("T1");

  await typing.controller.sendStatus(1);
  expect(typing.outbound.sendTyping).toHaveBeenCalledWith(1, "T1");

  // 发送报错含 "ticket" → 清空缓存
  typing.outbound.sendTyping.mockRejectedValueOnce(new Error("invalid typing_ticket"));
  await typing.controller.sendStatus(1);

  // 缓存已清 → 下一次 getTicket 重新取
  typing.outbound.getTypingTicket.mockResolvedValue("T2");
  expect(await typing.controller.getTicket()).toBe("T2");
  expect(typing.outbound.getTypingTicket).toHaveBeenCalledTimes(2);
});
