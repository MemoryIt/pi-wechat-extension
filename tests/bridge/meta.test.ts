/**
 * tests/bridge/meta.test.ts
 *
 * meta.ts 单测：buildMetaInfo 的元信息拼装与增量成本累计。
 *
 * 注意：成本累计状态现为 `MetaBuilder` 实例字段；用例各自创建实例，
 * 实例内多次调用共享累计状态。
 */
import { test, expect } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MetaBuilder } from "../../src/bridge/meta.js";

let usageReads = 0;

function makeCtx(branch: unknown[]): ExtensionContext {
  return {
    cwd: "/tmp/proj",
    model: { provider: "anthropic", id: "claude-test" },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    sessionManager: { getBranch: () => branch, getEntry: () => undefined },
  } as unknown as ExtensionContext;
}

test("buildMetaInfo：无成本时输出 cwd / 上下文 / 模型", () => {
  const metaBuilder = new MetaBuilder();
  const info = metaBuilder.buildMetaInfo(makeCtx([]));
  expect(info).toContain("/tmp/proj");
  expect(info).toContain("0.5%/200k");
  expect(info).toContain("(anthropic) claude-test");
  expect(info).not.toContain("$");
});

test("accumulateCost：增量累计且不重复读取旧 entry", () => {
  const first = {
    type: "message",
    id: "cost-first",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      get usage() {
        usageReads += 1;
        return { cost: { total: 0.1 } };
      },
    },
  };
  const second = {
    type: "message",
    id: "cost-second",
    message: { role: "assistant", content: [{ type: "text", text: "second" }], usage: { cost: { total: 0.2 } } },
  };

  const metaBuilder = new MetaBuilder();
  expect(metaBuilder.accumulateCost(makeCtx([first]))).toBeCloseTo(0.1, 5);
  expect(usageReads).toBe(1);

  const info = metaBuilder.buildMetaInfo(makeCtx([first, second]));
  expect(usageReads).toBe(1);
  expect(info).toContain("$0.300");
});
