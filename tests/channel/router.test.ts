/**
 * tests/channel/router.test.ts
 *
 * B2：直接对 MessageRouter（turn 执行 + 队列排空）做单测。
 * 不触碰底层边界，用 fake queue/mediaStore/mediaQueue/sender/host/logger。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { TurnQueue, SerialTaskQueue } from "../../src/channel/queue.js";
import { MessageRouter } from "../../src/channel/router.js";
import type { RouterDeps, RouterTurnOptions } from "../../src/channel/router.js";
import { MessageItemType } from "../../src/ports/types.js";
import type { WeixinMessage } from "../../src/ports/types.js";
import { createLogger } from "../../src/shared/logger.js";
import type { PiHost } from "../../src/ports/pi-host.js";

const opts: RouterTurnOptions = { baseUrl: "https://example.com", token: "tok" };

function textMsg(text: string): WeixinMessage {
  return {
    context_token: "CTX",
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function mediaMsg(type = MessageItemType.IMAGE): WeixinMessage {
  return { context_token: "CTX", item_list: [{ type, image_item: {} }] as never };
}

interface FakeHost {
  appendEntry: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
}

function makeHost(): FakeHost {
  return {
    appendEntry: mock((_t: string, _d: unknown) => {}),
    sendUserMessage: mock((_c: string, _o: unknown) => {}),
    sendMessage: mock((_m: unknown, _o: unknown) => {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Harness {
  router: MessageRouter;
  queue: TurnQueue<{ msg: WeixinMessage; requestId: string }>;
  host: FakeHost;
  sender: { sendText: ReturnType<typeof mock> };
  mediaStore: { downloadAll: ReturnType<typeof mock> };
  mediaQueue: SerialTaskQueue;
  loggerErrors: string[];
  processed: string[];
}

function makeHarness(
  overrides: Partial<Pick<RouterDeps, "getHost" | "getOpts" | "isTerminalProcessing">> = {},
): Harness {
  const queue = new TurnQueue<{ msg: WeixinMessage; requestId: string }>();
  const host = makeHost();
  const sender = { sendText: mock(async (_t: string) => {}) };
  const mediaStore = { downloadAll: mock(async (_items: unknown, _base: string) => [] as string[]) };
  const errors: string[] = [];
  const logger = createLogger({ sink: { log() {}, warn() {}, error: (...a) => errors.push(String(a[0])) } });
  const mediaQueue = new SerialTaskQueue(() => {});

  const router = new MessageRouter({
    queue,
    mediaStore,
    mediaQueue,
    sender: sender as unknown as RouterDeps["sender"],
    getHost: overrides.getHost ?? (() => host as unknown as PiHost),
    getOpts: overrides.getOpts ?? (() => opts),
    isTerminalProcessing: overrides.isTerminalProcessing ?? (() => false),
    logger,
  });

  return { router, queue, host, sender, mediaStore, mediaQueue, loggerErrors: errors, processed: [] };
}

beforeEach(() => {});

// ---------------------------------------------------------------------------
// dispatch：turn 编排唯一入口
// ---------------------------------------------------------------------------

test("router.dispatch 空闲：直接调用 execute（宿主收到消息）", async () => {
  const h = makeHarness();
  await h.router.dispatch(textMsg("hello"), "D1", opts);

  expect(h.host.appendEntry).toHaveBeenCalledTimes(1);
  expect(h.host.appendEntry.mock.calls[0]).toEqual(["wechat_meta", { requestId: "D1" }]);
  expect(h.host.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(h.queue.size).toBe(0);
  expect(h.queue.isBusy()).toBe(true);
  expect(h.queue.getCurrentRequestId()).toBe("D1");
});

test("router.dispatch 忙：入队不执行", async () => {
  const h = makeHarness();
  h.queue.setBusy(true);

  await h.router.dispatch(textMsg("queued"), "D2", opts);

  expect(h.queue.size).toBe(1);
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
  expect(h.queue.getCurrentRequestId()).toBeNull();
});

test("router.dispatch 终端处理中：入队不执行", async () => {
  const h = makeHarness({ isTerminalProcessing: () => true });

  await h.router.dispatch(textMsg("queued"), "D3", opts);

  expect(h.queue.size).toBe(1);
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
  expect(h.queue.isBusy()).toBe(false);
});

// ---------------------------------------------------------------------------
// onTurnDone：释放忙闲 + 排空
// ---------------------------------------------------------------------------

test("router.onTurnDone：清 busy/currentRequestId；有排队则排空队首", async () => {
  const h = makeHarness();
  h.queue.setBusy(true);
  h.queue.setCurrentRequestId("R-done");
  h.queue.enqueue({ msg: textMsg("next"), requestId: "N1" });

  h.router.onTurnDone();

  // 同步阶段：忙闲与 currentRequestId 立即释放
  expect(h.queue.isBusy()).toBe(false);
  expect(h.queue.getCurrentRequestId()).toBeNull();

  // 排空（20ms 延迟）后队首被执行
  await sleep(40);
  expect(h.queue.size).toBe(0);
  expect(h.host.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(h.host.sendUserMessage.mock.calls[0][0]).toBe("next");
});

test("router.onTurnDone：空队列仅释放忙闲，不再执行", async () => {
  const h = makeHarness();
  h.queue.setBusy(true);
  h.queue.setCurrentRequestId("R-none");

  h.router.onTurnDone();
  await sleep(40);

  expect(h.queue.isBusy()).toBe(false);
  expect(h.queue.getCurrentRequestId()).toBeNull();
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 文本 turn
// ---------------------------------------------------------------------------

test("router.execute 文本：appendEntry + sendUserMessage，成功后保持 busy", async () => {
  const h = makeHarness();
  await h.router.execute(textMsg("hello"), "R1", opts);

  expect(h.host.appendEntry).toHaveBeenCalledTimes(1);
  expect(h.host.appendEntry.mock.calls[0]).toEqual(["wechat_meta", { requestId: "R1" }]);
  expect(h.host.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(h.host.sendUserMessage.mock.calls[0]).toEqual(["hello", { deliverAs: "followUp" }]);
  // 成功交接给 agent：保持 busy 等待 onAiDone
  expect(h.queue.isBusy()).toBe(true);
  expect(h.queue.getCurrentRequestId()).toBe("R1");
});

test("router.execute 文本：host 缺失时释放忙闲并标记处理完成", async () => {
  const h = makeHarness({ getHost: () => null });
  await h.router.execute(textMsg("hi"), "R2", opts);

  expect(h.host.appendEntry).not.toHaveBeenCalled();
  expect(h.queue.isBusy()).toBe(false);
  expect(h.queue.getCurrentRequestId()).toBeNull();
  expect(h.queue.isRequestProcessed("R2")).toBe(true);
  expect(h.loggerErrors.some((e) => e.includes("execute failed"))).toBe(true);
});

test("router.execute 文本：sendUserMessage 同步抛错不冒泡且释放忙闲", async () => {
  const h = makeHarness();
  h.host.sendUserMessage.mockImplementation(() => {
    throw new Error("agent busy");
  });

  await expect(h.router.execute(textMsg("hi"), "R3", opts)).resolves.toBeUndefined();
  expect(h.queue.isBusy()).toBe(false);
  expect(h.queue.isRequestProcessed("R3")).toBe(true);
});

// ---------------------------------------------------------------------------
// 媒体 turn
// ---------------------------------------------------------------------------

test("router.execute 媒体：立即 ack、入后台队列、不占用忙闲", async () => {
  const h = makeHarness();
  h.mediaStore.downloadAll.mockResolvedValue([]);

  await h.router.execute(mediaMsg(), "M1", opts);

  expect(h.sender.sendText).toHaveBeenCalledTimes(1);
  expect(String(h.sender.sendText.mock.calls[0][0])).toContain("媒体文件已收到");
  expect(h.queue.isRequestProcessed("M1")).toBe(true);
  expect(h.queue.isBusy()).toBe(false);
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
});

test("router 媒体后台：下载完成后写 wechat_media history", async () => {
  const h = makeHarness();
  let release!: (v: unknown) => void;
  h.mediaStore.downloadAll.mockImplementation(
    () => new Promise<string[]>((res) => (release = res as (v: unknown) => void)),
  );

  await h.router.execute(mediaMsg(), "M2", opts);
  expect(h.host.sendMessage).not.toHaveBeenCalled();

  release(["/tmp/media/pic.png"]);
  await sleep(30);

  expect(h.host.sendMessage).toHaveBeenCalledTimes(1);
  const [payload, callOpts] = h.host.sendMessage.mock.calls[0];
  expect((payload as { customType: string }).customType).toBe("wechat_media");
  expect((payload as { content: string }).content).toContain("/tmp/media/pic.png");
  expect(callOpts).toEqual({ triggerTurn: false, deliverAs: "followUp" });
});

test("F6 目标：媒体 ack 失败不抛，仍标记处理并照常入后台队列", async () => {
  const h = makeHarness();
  h.sender.sendText.mockImplementation(async () => {
    throw new Error("ack failed");
  });
  h.mediaStore.downloadAll.mockResolvedValue([]);

  // ack 失败不得冒泡到调用方
  await expect(h.router.execute(mediaMsg(), "M3", opts)).resolves.toBeUndefined();

  expect(h.loggerErrors.some((e) => e.includes("Media ack failed"))).toBe(true);
  // 仍标记已处理
  expect(h.queue.isRequestProcessed("M3")).toBe(true);
  expect(h.queue.isBusy()).toBe(false);

  // 仍入后台队列，任务照常执行
  await sleep(30);
  expect(h.mediaStore.downloadAll).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// drain
// ---------------------------------------------------------------------------

test("router.drain：空队列直接释放忙闲", async () => {
  const h = makeHarness();
  h.queue.setBusy(true);
  await h.router.drain();
  expect(h.queue.isBusy()).toBe(false);
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
});

test("router.drain：取队首执行（20ms 后）", async () => {
  const h = makeHarness();
  h.queue.enqueue({ msg: textMsg("queued"), requestId: "Q1" });
  const started = Date.now();
  await h.router.drain();
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  expect(h.queue.size).toBe(0);
  expect(h.host.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(h.host.sendUserMessage.mock.calls[0][0]).toBe("queued");
});

test("router.drain：execute rejection 被捕获并释放状态", async () => {
  const h = makeHarness();
  // F6 后媒体 ack 失败已在 execute 内部被隔离，不再能让媒体分支拒绝。
  // 这里直接让 execute 拒绝，专门验证 drain 对 execute rejection 的兜底处理。
  h.router.execute = mock(async (_msg: unknown, _requestId: string, _o: unknown) => {
    throw new Error("send boom");
  }) as unknown as typeof h.router.execute;
  h.queue.enqueue({ msg: mediaMsg(), requestId: "Q2" });

  await h.router.drain();

  expect(h.queue.isBusy()).toBe(false);
  expect(h.queue.getCurrentRequestId()).toBeNull();
  expect(h.loggerErrors.some((e) => e.includes("Failed to process queued message"))).toBe(true);
});

test("router.drain：config 缺失时释放忙闲并继续排空", async () => {
  const h = makeHarness({ getOpts: () => null });
  h.queue.enqueue({ msg: textMsg("x"), requestId: "Q3" });
  await h.router.drain();
  expect(h.queue.isBusy()).toBe(false);
  expect(h.host.sendUserMessage).not.toHaveBeenCalled();
  expect(h.loggerErrors.some((e) => e.includes("config missing"))).toBe(true);
});
