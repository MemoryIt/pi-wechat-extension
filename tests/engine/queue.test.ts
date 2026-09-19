/**
 * tests/engine/queue.test.ts
 *
 * TurnQueue 纯单测（无外部依赖）：FIFO、忙闲/requestId、去重、
 * 过期清理（阈值 50 / 1h）、reset。
 */
import { test, expect, setSystemTime } from "bun:test";
import { TurnQueue, SerialTaskQueue } from "../../src/engine/queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitIdle(q: SerialTaskQueue, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!q.idle) {
    if (Date.now() - start > timeoutMs) throw new Error("waitIdle timeout");
    await sleep(1);
  }
}

test("FIFO：enqueue 1,2,3 → dequeue 依次 1,2,3，size 正确", () => {
  const q = new TurnQueue<number>();
  expect(q.size).toBe(0);
  q.enqueue(1);
  q.enqueue(2);
  q.enqueue(3);
  expect(q.size).toBe(3);
  expect(q.dequeue()).toBe(1);
  expect(q.size).toBe(2);
  expect(q.dequeue()).toBe(2);
  expect(q.dequeue()).toBe(3);
  expect(q.size).toBe(0);
  expect(q.dequeue()).toBeUndefined();
});

test("busy / currentRequestId 读写", () => {
  const q = new TurnQueue<number>();
  expect(q.isBusy()).toBe(false);
  expect(q.getCurrentRequestId()).toBeNull();

  q.setBusy(true);
  q.setCurrentRequestId("r1");
  expect(q.isBusy()).toBe(true);
  expect(q.getCurrentRequestId()).toBe("r1");

  q.setBusy(false);
  q.setCurrentRequestId(null);
  expect(q.isBusy()).toBe(false);
  expect(q.getCurrentRequestId()).toBeNull();
});

test("去重：markRequestProcessed 后 isRequestProcessed 为 true", () => {
  const q = new TurnQueue<number>();
  expect(q.isRequestProcessed("a")).toBe(false);
  q.markRequestProcessed("a");
  expect(q.isRequestProcessed("a")).toBe(true);
  expect(q.isRequestProcessed("b")).toBe(false);
});

test("cleanup：第 50 次 mark 触发清理，删除 1h 前记录并重置计数", () => {
  const q = new TurnQueue<number>();
  const t0 = new Date("2026-01-02T03:00:00.000Z");
  setSystemTime(t0);
  try {
    // 49 条老记录：未达到阈值 50，不触发 cleanup
    for (let i = 0; i < 49; i++) q.markRequestProcessed(`old-${i}`);
    expect(q.isRequestProcessed("old-0")).toBe(true);
    expect(q.isRequestProcessed("old-48")).toBe(true);

    // 时间前进 2 小时，使上面 49 条全部过期
    setSystemTime(new Date(t0.getTime() + 2 * 3600_000));

    // 第 50 次 mark → 触发 cleanup
    q.markRequestProcessed("new-1");

    expect(q.isRequestProcessed("old-0")).toBe(false);
    expect(q.isRequestProcessed("old-48")).toBe(false);
    expect(q.isRequestProcessed("new-1")).toBe(true);
    expect((q as unknown as { cleanupCounter: number }).cleanupCounter).toBe(0);
  } finally {
    setSystemTime();
  }
});

test("reset：清空 pending / busy / currentRequestId / processed / 计数", () => {
  const q = new TurnQueue<number>();
  q.enqueue(1);
  q.setBusy(true);
  q.setCurrentRequestId("r1");
  q.markRequestProcessed("a");

  q.reset();

  expect(q.size).toBe(0);
  expect(q.isBusy()).toBe(false);
  expect(q.getCurrentRequestId()).toBeNull();
  expect(q.isRequestProcessed("a")).toBe(false);
  expect((q as unknown as { cleanupCounter: number }).cleanupCounter).toBe(0);
});

// ---------------------------------------------------------------------------
// SerialTaskQueue
// ---------------------------------------------------------------------------

test("SerialTaskQueue：串行执行，后一任务等前一任务完成", async () => {
  const order: string[] = [];
  const q = new SerialTaskQueue(() => {});

  q.enqueue(async () => {
    order.push("a-start");
    await sleep(20);
    order.push("a-end");
  });
  q.enqueue(async () => {
    order.push("b-start");
    order.push("b-end");
  });

  await waitIdle(q);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("SerialTaskQueue：任务抛错调用 onError，且不阻断后续任务", async () => {
  const errors: unknown[] = [];
  const ran: string[] = [];
  const q = new SerialTaskQueue((err) => errors.push(err));

  q.enqueue(async () => {
    ran.push("first");
    throw new Error("boom");
  });
  q.enqueue(async () => {
    ran.push("second");
  });
  q.enqueue(async () => {
    ran.push("third");
  });

  await waitIdle(q);
  expect(ran).toEqual(["first", "second", "third"]);
  expect(errors.length).toBe(1);
  expect((errors[0] as Error).message).toBe("boom");
});

test("SerialTaskQueue：onError 自身抛错也不阻断后续任务", async () => {
  const ran: string[] = [];
  const q = new SerialTaskQueue(() => {
    throw new Error("onError-boom");
  });

  q.enqueue(async () => {
    ran.push("first");
    throw new Error("task-boom");
  });
  q.enqueue(async () => {
    ran.push("second");
  });

  await waitIdle(q);
  expect(ran).toEqual(["first", "second"]);
});

test("SerialTaskQueue：idle 在入队后为 false，全部 settle 后为 true", async () => {
  const q = new SerialTaskQueue(() => {});
  expect(q.idle).toBe(true);

  q.enqueue(async () => {
    await sleep(10);
  });
  expect(q.idle).toBe(false);

  await waitIdle(q);
  expect(q.idle).toBe(true);
});
