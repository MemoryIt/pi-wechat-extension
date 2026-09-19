/**
 * tests/engine/engine.test.ts
 *
 * L2：直接测试 wechat.ts 的 WechatEngine。
 * 底层边界（api/messaging/media）用 mock.module 顶掉，storage/config 用真实实现 + 临时目录。
 *
 * 覆盖：D3 轮询重入、D6 同步抛错被吞、D7 队列 rejection 未处理、
 *       D9 未传 AbortSignal、D13 requestId 同毫秒冲突、
 *       D14 fileName 被忽略、D15 slash 判定、D16 typing ticket 缓存不失效 / timer 泄漏。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { setSystemTime } from "bun:test";
import { resetAgentDir } from "../setup/mocks";
import {
  installEngineMocks,
  importEngine,
  importStorage,
  importConfig,
  createEnginePi,
  resetBoundaryMocks,
  apiMock,
  sendMediaMock,
  opts,
  textMessage,
  seedSingleUser,
  sleep,
  waitFor,
  MessageItemType,
} from "../setup/engine-harness";

installEngineMocks();

const engineModule = await importEngine();
const { engine, setPi, setConfig } = engineModule;
const storage = await importStorage();
const config = await importConfig();

type AnyEngine = Record<string, any>;

let pi: ReturnType<typeof createEnginePi>;

beforeEach(async () => {
  resetAgentDir();
  resetBoundaryMocks();
  config.clearConfigCache();
  delete process.env.WECHAT_DEBUG;
  delete process.env.WECHAT_MEDIA_PATH;

  pi = createEnginePi();
  setPi(pi as never);
  setConfig({ baseUrl: opts.baseUrl, token: opts.token });

  engine.reset();
  const e = engine as unknown as AnyEngine;
  e.isTerminalMessageProcessing = false;
  e.consecutiveFailures = 0;
  e.typingTicketCache = null;

  await seedSingleUser(storage);
});

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

test("基线：startPolling 消费文本消息、写入 wechat_meta 并持久化 cursor", async () => {
  let call = 0;
  const resolvers: Array<(v: unknown) => void> = [];
  apiMock.getUpdates.mockImplementation(() => {
    call += 1;
    if (call === 1) {
      return Promise.resolve({ msgs: [textMessage("hello engine")], get_updates_buf: "cursor-1" });
    }
    return new Promise((res) => resolvers.push(res));
  });

  const p = engine.startPolling(opts);
  await waitFor(() => pi.calls.sendUserMessage.length > 0);
  await sleep(30);

  expect(pi.calls.appendEntry[0][0]).toBe("wechat_meta");
  expect(String(pi.calls.sendUserMessage[0][0])).toContain("hello engine");
  expect(await storage.loadSyncCursor("acc1")).toBe("cursor-1");

  engine.stopPolling();
  resolvers.splice(0).forEach((r) => r({ msgs: [], get_updates_buf: "cursor-1" }));
  await p;
});

// ---------------------------------------------------------------------------
// D3：startPolling 可重入
// ---------------------------------------------------------------------------

test("D3 证伪：重复 startPolling 会并发启动两条轮询循环", async () => {
  const resolvers: Array<() => void> = [];
  apiMock.getUpdates.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ msgs: [], get_updates_buf: "" }));
      }),
  );

  const p1 = engine.startPolling(opts);
  const p2 = engine.startPolling(opts);

  await waitFor(() => apiMock.getUpdates.mock.calls.length >= 2);
  expect(apiMock.getUpdates).toHaveBeenCalledTimes(2);

  engine.stopPolling();
  resolvers.splice(0).forEach((fn) => fn());
  await Promise.allSettled([p1, p2]);
});

test.failing("D3 目标：重复 startPolling 不应并发两条轮询循环", async () => {
  const resolvers: Array<() => void> = [];
  apiMock.getUpdates.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ msgs: [], get_updates_buf: "" }));
      }),
  );

  const p1 = engine.startPolling(opts);
  const p2 = engine.startPolling(opts);

  await sleep(60);
  expect(apiMock.getUpdates).toHaveBeenCalledTimes(1);

  engine.stopPolling();
  resolvers.splice(0).forEach((fn) => fn());
  await Promise.allSettled([p1, p2]);
});

// ---------------------------------------------------------------------------
// D9：未向 getUpdates 传递 AbortSignal
// ---------------------------------------------------------------------------

test("D9 证伪：getUpdates 未收到 AbortSignal，无法即时取消在途长轮询", async () => {
  let captured: Record<string, unknown> | null = null;
  const resolvers: Array<(v: unknown) => void> = [];
  apiMock.getUpdates.mockImplementation((o: unknown) => {
    captured = o as Record<string, unknown>;
    return new Promise((res) => resolvers.push(res));
  });

  const p = engine.startPolling(opts);
  await waitFor(() => captured !== null);

  expect(captured).not.toBeNull();
  expect("signal" in (captured as Record<string, unknown>)).toBe(false);

  engine.stopPolling();
  resolvers.splice(0).forEach((r) => r({ msgs: [], get_updates_buf: "" }));
  await p;
});

test.failing("D9 目标：getUpdates 应收到 AbortSignal 以便即时取消", async () => {
  let captured: Record<string, unknown> | null = null;
  const resolvers: Array<(v: unknown) => void> = [];
  apiMock.getUpdates.mockImplementation((o: unknown) => {
    captured = o as Record<string, unknown>;
    return new Promise((res) => resolvers.push(res));
  });

  const p = engine.startPolling(opts);
  await waitFor(() => captured !== null);

  expect(captured).not.toBeNull();
  expect("signal" in (captured as Record<string, unknown>)).toBe(true);

  engine.stopPolling();
  resolvers.splice(0).forEach((r) => r({ msgs: [], get_updates_buf: "" }));
  await p;
});

// ---------------------------------------------------------------------------
// D13：requestId 同毫秒冲突
// ---------------------------------------------------------------------------

test("D13 证伪：同一毫秒内生成的 requestId 完全相同", () => {
  setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
  try {
    const e = engine as unknown as AnyEngine;
    const a = e.generateRequestId();
    const b = e.generateRequestId();
    expect(a).toBe(b);
  } finally {
    setSystemTime();
  }
});

test.failing("D13 目标：同一毫秒内的 requestId 应保持唯一", () => {
  setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
  try {
    const e = engine as unknown as AnyEngine;
    const a = e.generateRequestId();
    const b = e.generateRequestId();
    expect(a).not.toBe(b);
  } finally {
    setSystemTime();
  }
});

// ---------------------------------------------------------------------------
// D6：sendUserMessage 同步抛错
// ---------------------------------------------------------------------------

test("D6 证伪：sendUserMessage 同步抛错会使 isAiProcessing 卡住并向上冒泡", async () => {
  await engine.initSingleUser();
  pi.sendUserMessage.mockImplementation(() => {
    throw new Error("agent busy");
  });

  await expect(engine.handleMessage(textMessage("hi"), opts)).rejects.toThrow("agent busy");
  expect((engine as unknown as AnyEngine).isAiProcessing).toBe(true);
});

test.failing("D6 目标：sendUserMessage 抛错后应释放 isAiProcessing", async () => {
  await engine.initSingleUser();
  pi.sendUserMessage.mockImplementation(() => {
    throw new Error("agent busy");
  });

  try {
    await engine.handleMessage(textMessage("hi"), opts);
  } catch {
    // 允许仍向上抛出，但状态必须释放
  }
  expect((engine as unknown as AnyEngine).isAiProcessing).toBe(false);
});

// ---------------------------------------------------------------------------
// D14：sendFileToUser 忽略自定义 fileName
// ---------------------------------------------------------------------------

test("D14 证伪：sendFileToUser 忽略自定义 fileName", async () => {
  await engine.initSingleUser();
  await engine.sendFileToUser("/tmp/sample.pptx", "report-q1.pptx");

  expect(sendMediaMock.sendWeixinMediaFile).toHaveBeenCalledTimes(1);
  const arg = sendMediaMock.sendWeixinMediaFile.mock.calls[0][0];
  expect(JSON.stringify(arg)).not.toContain("report-q1.pptx");
});

test.failing("D14 目标：sendFileToUser 应把自定义 fileName 传给底层发送", async () => {
  await engine.initSingleUser();
  await engine.sendFileToUser("/tmp/sample.pptx", "report-q1.pptx");

  expect(sendMediaMock.sendWeixinMediaFile).toHaveBeenCalledTimes(1);
  const arg = sendMediaMock.sendWeixinMediaFile.mock.calls[0][0];
  expect(JSON.stringify(arg)).toContain("report-q1.pptx");
});

// ---------------------------------------------------------------------------
// D15：isSlashCommand 魔法数字 + 只看首条
// ---------------------------------------------------------------------------

test("D15 基线：首条即为文本且以 / 开头时判定为 slash command", () => {
  const e = engine as unknown as AnyEngine;
  const isSlash = e.isSlashCommand.bind(engine);
  expect(isSlash({ item_list: [{ type: MessageItemType.TEXT, text_item: { text: "/help" } }] })).toBe(true);
  expect(isSlash({ item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hi" } }] })).toBe(false);
});

test("D15 证伪：文本不在首条时漏判 slash command", () => {
  const e = engine as unknown as AnyEngine;
  const isSlash = e.isSlashCommand.bind(engine);
  const msg = {
    item_list: [
      { type: MessageItemType.IMAGE, image_item: {} },
      { type: MessageItemType.TEXT, text_item: { text: "/help" } },
    ],
  };
  expect(isSlash(msg)).toBe(false);
});

test.failing("D15 目标：应能识别非首条文本中的 slash command", () => {
  const e = engine as unknown as AnyEngine;
  const isSlash = e.isSlashCommand.bind(engine);
  const msg = {
    item_list: [
      { type: MessageItemType.IMAGE, image_item: {} },
      { type: MessageItemType.TEXT, text_item: { text: "/help" } },
    ],
  };
  expect(isSlash(msg)).toBe(true);
});

// ---------------------------------------------------------------------------
// D16：typing ticket 缓存不随 contextToken 失效
// ---------------------------------------------------------------------------

test("D16 证伪：contextToken 变化后 typing ticket 仍复用旧缓存", async () => {
  await engine.initSingleUser();
  apiMock.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "T1" });

  const t1 = await engine.getTypingTicket();
  expect(t1).toBe("T1");

  (engine as unknown as AnyEngine).singleContextToken = "CTX-NEW";
  apiMock.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "T2" });

  const t2 = await engine.getTypingTicket();
  expect(t2).toBe("T1");
  expect(apiMock.getConfig).toHaveBeenCalledTimes(1);
});

test.failing("D16 目标：contextToken 变化后应重新获取 typing ticket", async () => {
  await engine.initSingleUser();
  apiMock.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "T1" });

  const t1 = await engine.getTypingTicket();
  expect(t1).toBe("T1");

  (engine as unknown as AnyEngine).singleContextToken = "CTX-NEW";
  apiMock.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "T2" });

  const t2 = await engine.getTypingTicket();
  expect(t2).toBe("T2");
  expect(apiMock.getConfig).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// D16b：typing keepalive 的 interval 未 unref
// ---------------------------------------------------------------------------

test("D16b 证伪：typing keepalive 的 interval 未调用 unref", async () => {
  const origSet = globalThis.setInterval;
  const origClear = globalThis.clearInterval;
  const unref = mock(() => {});
  globalThis.setInterval = ((_fn: unknown, _ms: unknown) => ({ unref })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;

  try {
    await engine.initSingleUser();
    await engine.startTypingKeepalive();
    expect(unref).not.toHaveBeenCalled();
  } finally {
    globalThis.setInterval = origSet;
    globalThis.clearInterval = origClear;
    await engine.stopTypingKeepalive();
  }
});

test.failing("D16b 目标：typing keepalive 的 interval 应调用 unref", async () => {
  const origSet = globalThis.setInterval;
  const origClear = globalThis.clearInterval;
  const unref = mock(() => {});
  globalThis.setInterval = ((_fn: unknown, _ms: unknown) => ({ unref })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;

  try {
    await engine.initSingleUser();
    await engine.startTypingKeepalive();
    expect(unref).toHaveBeenCalled();
  } finally {
    globalThis.setInterval = origSet;
    globalThis.clearInterval = origClear;
    await engine.stopTypingKeepalive();
  }
});

// ---------------------------------------------------------------------------
// D7：队列排空时 triggerAiInternal 的 rejection 未被引擎 await/catch
// ---------------------------------------------------------------------------

/**
 * 说明：Bun test 会把「未处理的 Promise rejection」直接判为用例失败，因此这里
 * 用一层包装把原始 rejection catch 下来用于观测，证明「引擎自身没有处理它」。
 * 这样既能量化缺陷，又不会污染全局 runner。
 */
function wrapTriggerToObserveRejection(captured: unknown[]): () => void {
  const e = engine as unknown as AnyEngine;
  const original = e.triggerAiInternal.bind(engine);
  e.triggerAiInternal = (msg: unknown, requestId: string, o: unknown) => {
    const p = original(msg, requestId, o) as Promise<void>;
    p.catch((err) => captured.push(err));
    return p;
  };
  return () => {
    delete e.triggerAiInternal;
  };
}

test("D7 证伪：队列排空时 triggerAiInternal 的 rejection 只能由外部兜底，队列已丢消息", async () => {
  await engine.initSingleUser();
  const e = engine as unknown as AnyEngine;

  const captured: unknown[] = [];
  const restore = wrapTriggerToObserveRejection(captured);
  try {
    e.isAiProcessing = true;
    await engine.triggerAi(textMessage("queued"), "R-queued", opts);
    expect(e.pendingMessages.length).toBe(1);

    pi.sendUserMessage.mockImplementation(() => {
      throw new Error("boom");
    });

    engine.onAiDone();
    await sleep(80);

    // 引擎没有处理 rejection（只有我们的包装 catch 到了）
    expect(captured.length).toBeGreaterThan(0);
    // 队列项已被 shift，没有重入处理
    expect(e.pendingMessages.length).toBe(0);
    // 状态未释放
    expect(e.isAiProcessing).toBe(true);
  } finally {
    restore();
  }
});

test.failing("D7 目标：队列排空时 rejecting turn 应由引擎处理并释放状态", async () => {
  await engine.initSingleUser();
  const e = engine as unknown as AnyEngine;

  const captured: unknown[] = [];
  const restore = wrapTriggerToObserveRejection(captured);
  try {
    e.isAiProcessing = true;
    await engine.triggerAi(textMessage("queued"), "R-queued", opts);

    pi.sendUserMessage.mockImplementation(() => {
      throw new Error("boom");
    });

    engine.onAiDone();
    await sleep(80);

    expect(e.isAiProcessing).toBe(false);
  } finally {
    restore();
  }
});
