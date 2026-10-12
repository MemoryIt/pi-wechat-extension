/**
 * tests/bridge/state-isolation.test.ts
 *
 * RF-3：证明组合根创建的实例之间状态互不共享。
 * - 两个 `TurnResolver`：向 A push 待处理输入，B 的解析不受影响。
 * - 两个 `MetaBuilder`：在 A 上累计成本，B 仍从 0 起算。
 */
import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TurnResolver } from "../../src/bridge/turn.js";
import { MetaBuilder } from "../../src/bridge/meta.js";

function makeCtx(branch: unknown[]): ExtensionContext {
  return {
    cwd: "/tmp/proj",
    model: { provider: "anthropic", id: "claude-test" },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    sessionManager: { getBranch: () => branch, getEntry: () => undefined },
  } as unknown as ExtensionContext;
}

test("TurnResolver：实例间 FIFO 状态隔离", () => {
  const a = new TurnResolver();
  const b = new TurnResolver();

  a.pushPendingWechatInput({ requestId: "R-a", text: "from a" });

  // B 未 push，不应看到 A 的待处理输入。
  expect(b.resolveTurnBeforeRun(makeCtx([]), "from a")).toEqual({
    fromWechat: false,
    requestId: null,
  });
  // A 仍能命中并消费。
  expect(a.resolveTurnBeforeRun(makeCtx([]), "from a")).toEqual({
    fromWechat: true,
    requestId: "R-a",
  });
  // 命中即出队：A 再次解析同一 prompt 也不应为微信 turn。
  expect(a.resolveTurnBeforeRun(makeCtx([]), "from a")).toEqual({
    fromWechat: false,
    requestId: null,
  });
});

test("MetaBuilder：实例间成本累计隔离", () => {
  const a = new MetaBuilder();
  const b = new MetaBuilder();

  const entry = {
    type: "message",
    id: "cost-1",
    message: { role: "assistant", usage: { cost: { total: 0.5 } } },
  };

  expect(a.accumulateCost(makeCtx([entry]))).toBeCloseTo(0.5, 5);
  // B 的累计器独立，空分支为 0。
  expect(b.accumulateCost(makeCtx([]))).toBe(0);
});

test("MetaBuilder：git 分支缓存实例隔离", async () => {
  const a = new MetaBuilder();
  const b = new MetaBuilder();

  const pi = { exec: async () => ({ stdout: "feature-branch\n" }) } as never;
  await a.refreshGitBranch(pi);

  expect(a.getCachedGitBranch()).toBe("feature-branch");
  expect(b.getCachedGitBranch()).toBeNull();
});
