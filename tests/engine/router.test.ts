/**
 * tests/engine/router.test.ts
 *
 * B2：直接对 MessageRouter（turn 执行 + 队列排空）做单测。
 * 不触碰底层边界，用 fake queue/mediaStore/mediaQueue/sender/host/logger。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { TurnQueue, SerialTaskQueue } from "../../src/queue.js";
import { MessageRouter } from "../../src/router.js";
import type { RouterDeps, RouterTurnOptions } from "../../src/router.js";
import { MessageItemType } from "../../api/types.js";
import type { WeixinMessage } from "../../api/types.js";
import { createLogger } from "../../src/logger.js";
import type { WechatHost } from "../../src/wechat.js";

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

function makeHarness(overrides: Partial<Pick<RouterDeps, "getHost" | "getOpts">> = {}): Harness {
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
    getHost: overrides.getHost ?? (() => host as unknown as WechatHost),
    getOpts: overrides.getOpts ?? (() => opts),
    logger,
  });

  return { router, queue, host, sender, mediaStore, mediaQueue, loggerErrors: errors, processed: [] };
}

beforeEach(() => {});

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
  // host.sendUserMessage 抛错 -> execute 内部吞掉；再单独制造 execute 抛错：
  // sender.sendText 抛错会让媒体分支的 execute 直接 reject。
  h.sender.sendText.mockImplementation(async () => {
    throw new Error("send boom");
  });
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
