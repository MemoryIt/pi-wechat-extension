/**
 * tests/engine/engine.test.ts
 *
 * L2：直接测试 wechat.ts 的 WechatEngine。
 * 微信边界经注入的端口 fake（inbound/outbound/media）观测，storage/config 用真实实现 + 临时目录。
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
  resetPortMocks,
  inboundMock,
  outboundMock,
  mediaMock,
  opts,
  textMessage,
  seedSingleUser,
  sleep,
  waitFor,
  MessageItemType,
} from "../setup/engine-harness";

installEngineMocks();

const engineModule = await importEngine();
const { createWechatEngine } = engineModule;
const storage = await importStorage();
const config = await importConfig();

type AnyEngine = Record<string, any>;

let pi: ReturnType<typeof createEnginePi>;
let engine: ReturnType<typeof createWechatEngine>;

function makeEngine(
  overrides: Partial<{ host: unknown; config: unknown; inbound: unknown; outbound: unknown; media: unknown }> = {},
) {
  return createWechatEngine({
    host: overrides.host as never,
    config: overrides.config as never,
    inbound: (overrides.inbound ?? inboundMock) as never,
    outbound: (overrides.outbound ?? outboundMock) as never,
    media: (overrides.media ?? mediaMock) as never,
  });
}

beforeEach(async () => {
  resetAgentDir();
  resetPortMocks();
  config.clearConfigCache();
  delete process.env.WECHAT_DEBUG;
  delete process.env.WECHAT_MEDIA_PATH;

  pi = createEnginePi();
  engine = makeEngine({
    host: pi,
    config: { baseUrl: opts.baseUrl, token: opts.token },
  });
  (engine as unknown as AnyEngine).isTerminalMessageProcessing = false;

  await seedSingleUser(storage);
});

// ---------------------------------------------------------------------------
// 基线
// ---------------------------------------------------------------------------

test("基线：startPolling 消费文本消息、写入 wechat_meta 并持久化 cursor", async () => {
  let call = 0;
  const resolvers: Array<(v: unknown) => void> = [];
  inboundMock.getUpdates.mockImplementation(() => {
    call += 1;
    if (call === 1) {
      return Promise.resolve({ messages: [textMessage("hello engine")], cursor: "cursor-1" });
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
  resolvers.splice(0).forEach((r) => r({ messages: [], cursor: "cursor-1" }));
  await p;
});

// ---------------------------------------------------------------------------
// D3：startPolling 可重入
// ---------------------------------------------------------------------------

test("D3 目标：重复 startPolling 不应并发两条轮询循环", async () => {
  const resolvers: Array<() => void> = [];
  inboundMock.getUpdates.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ messages: [], cursor: "" }));
      }),
  );

  const p1 = engine.startPolling(opts);
  const p2 = engine.startPolling(opts);

  await sleep(60);
  expect(inboundMock.getUpdates).toHaveBeenCalledTimes(1);

  engine.stopPolling();
  resolvers.splice(0).forEach((fn) => fn());
  await Promise.allSettled([p1, p2]);
});

// ---------------------------------------------------------------------------
// D9：未向 getUpdates 传递 AbortSignal
// ---------------------------------------------------------------------------

test("D9 限制说明：底层 getUpdates 不接受 AbortSignal（核心层改用 Promise.race 抢跑）", async () => {
  let captured: Record<string, unknown> | null = null;
  const resolvers: Array<(v: unknown) => void> = [];
  inboundMock.getUpdates.mockImplementation((o: unknown) => {
    captured = o as Record<string, unknown>;
    return new Promise((res) => resolvers.push(res));
  });

  const p = engine.startPolling(opts);
  await waitFor(() => captured !== null);

  expect(captured).not.toBeNull();
  // 这是底层限制：getUpdates 的签名没有 AbortSignal，核心层无法把 signal
  // 透传下去。因此 stopPolling 用 Promise.race 让循环迅速退出，而在途请求
  // 仍会在后台直到自身超时。
  expect("signal" in (captured as Record<string, unknown>)).toBe(false);

  engine.stopPolling();
  resolvers.splice(0).forEach((r) => r({ messages: [], cursor: "" }));
  await p;
});

test("D9 目标：stopPolling 后 startPolling 应在 300ms 内 resolve", async () => {
  // getUpdates 永不 resolve，模拟底层长轮询挂起
  inboundMock.getUpdates.mockImplementation(() => new Promise(() => {}));

  const p = engine.startPolling(opts);
  await waitFor(() => inboundMock.getUpdates.mock.calls.length >= 1);

  const started = Date.now();
  engine.stopPolling();
  await Promise.race([
    p,
    sleep(300).then(() => {
      throw new Error("startPolling did not resolve within 300ms");
    }),
  ]);
  expect(Date.now() - started).toBeLessThan(300);
});

// ---------------------------------------------------------------------------
// D13：requestId 同毫秒冲突
// ---------------------------------------------------------------------------

test("D13 目标：同一毫秒内的 requestId 应保持唯一", () => {
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

test("D6 目标：sendUserMessage 抛错后应释放 isAiProcessing 且不冒泡", async () => {
  await engine.initSingleUser();
  pi.sendUserMessage.mockImplementation(() => {
    throw new Error("agent busy");
  });

  // 不得向上冒泡成「轮询失败 / connectionState=error」
  await expect(engine.handleMessage(textMessage("hi"), opts)).resolves.toBeUndefined();
  expect((engine as unknown as AnyEngine).queue.isBusy()).toBe(false);
  expect(engine.connectionState).toBe("disconnected");
});

// ---------------------------------------------------------------------------
// D14：sendFileToUser 只以本地文件名提交（底层不支持自定义显示名）
// ---------------------------------------------------------------------------

test("基线：sendFileToUser 以本地文件路径提交底层发送（不再传 display-name 字段）", async () => {
  await engine.initSingleUser();
  await engine.sendFileToUser("/tmp/sample.pptx");

  expect(outboundMock.sendFile).toHaveBeenCalledTimes(1);
  expect(outboundMock.sendFile).toHaveBeenCalledWith("/tmp/sample.pptx");
  // 端口只有本地路径一个参数，底层不支持自定义显示名
  expect(outboundMock.sendFile.mock.calls[0].length).toBe(1);
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

test("D15 目标：应能识别非首条文本中的 slash command", () => {
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

test("D16 目标：contextToken 变化后应重新获取 typing ticket", async () => {
  await engine.initSingleUser();
  outboundMock.getTypingTicket.mockResolvedValue("T1");

  const t1 = await engine.getTypingTicket();
  expect(t1).toBe("T1");

  (engine as unknown as AnyEngine).singleContextToken = "CTX-NEW";
  outboundMock.getTypingTicket.mockResolvedValue("T2");

  const t2 = await engine.getTypingTicket();
  expect(t2).toBe("T2");
  expect(outboundMock.getTypingTicket).toHaveBeenCalledTimes(2);
});

test("D16 目标：ticket 缓存 60s TTL 内命中、过期后重新获取", async () => {
  await engine.initSingleUser();
  outboundMock.getTypingTicket.mockResolvedValue("T1");

  expect(await engine.getTypingTicket()).toBe("T1");
  // TTL 内命中缓存
  expect(await engine.getTypingTicket()).toBe("T1");
  expect(outboundMock.getTypingTicket).toHaveBeenCalledTimes(1);

  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    outboundMock.getTypingTicket.mockResolvedValue("T2");
    expect(await engine.getTypingTicket()).toBe("T2");
  } finally {
    Date.now = realNow;
  }
  expect(outboundMock.getTypingTicket).toHaveBeenCalledTimes(2);
});

test("D16 目标：sendTyping 报错含 'ticket' 时清空缓存并重新获取", async () => {
  await engine.initSingleUser();
  outboundMock.getTypingTicket.mockResolvedValue("T1");

  await engine.sendTypingStatus(1);
  expect(outboundMock.sendTyping).toHaveBeenCalledWith(1, "T1");

  // 发送报错含 "ticket" → 清空缓存
  outboundMock.sendTyping.mockRejectedValueOnce(new Error("invalid typing_ticket"));
  await engine.sendTypingStatus(1);

  // 缓存已清 → 下一次 getTypingTicket 重新取
  outboundMock.getTypingTicket.mockResolvedValue("T2");
  expect(await engine.getTypingTicket()).toBe("T2");
  expect(outboundMock.getTypingTicket).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// D16b：typing keepalive 的 interval 未 unref
// ---------------------------------------------------------------------------

test("D16b 目标：typing keepalive 的 interval 应调用 unref", async () => {
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
// D7：队列排空时 execute 的 rejection 未被引擎 await/catch
// ---------------------------------------------------------------------------

/**
 * 说明：Bun test 会把「未处理的 Promise rejection」直接判为用例失败，因此这里
 * 用一层包装把原始 rejection catch 下来用于观测，证明「引擎自身没有处理它」。
 * 这样既能量化缺陷，又不会污染全局 runner。
 */
function wrapTriggerToObserveRejection(captured: unknown[]): () => void {
  const e = engine as unknown as AnyEngine;
  const router = e.router as { execute: (msg: unknown, requestId: string, o: unknown) => Promise<void> };
  const original = router.execute.bind(router);
  router.execute = (msg: unknown, requestId: string, o: unknown) => {
    const p = original(msg, requestId, o) as Promise<void>;
    p.catch((err) => captured.push(err));
    return p;
  };
  return () => {
    delete (router as Record<string, unknown>).execute;
  };
}

test("D7 目标：队列排空时 rejecting turn 应由引擎处理并释放状态", async () => {
  await engine.initSingleUser();
  const e = engine as unknown as AnyEngine;

  const captured: unknown[] = [];
  const restore = wrapTriggerToObserveRejection(captured);
  try {
    e.queue.setBusy(true);
    await engine.triggerAi(textMessage("queued"), "R-queued", opts);

    pi.sendUserMessage.mockImplementation(() => {
      throw new Error("boom");
    });

    engine.onAiDone();
    await sleep(80);

    expect(e.queue.isBusy()).toBe(false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// C9：实例级依赖注入，不依赖模块单例状态
// ---------------------------------------------------------------------------

test("C9 目标：createWechatEngine 独立实例注入 fake host/config，不污染模块单例", async () => {
  const isolatedPi = createEnginePi();
  const isolated = createWechatEngine({
    host: isolatedPi,
    config: { baseUrl: opts.baseUrl, token: opts.token },
    inbound: inboundMock as never,
    outbound: outboundMock as never,
    media: mediaMock as never,
  });

  await isolated.triggerAi(textMessage("isolated hello"), "R-iso", opts);

  // fake host 收到调用（走实例自身的 host，而非模块级 pi）
  expect(isolatedPi.calls.appendEntry[0][0]).toBe("wechat_meta");
  expect(isolatedPi.calls.appendEntry[0][1]).toEqual({ requestId: "R-iso" });
  expect(isolatedPi.calls.sendUserMessage.length).toBe(1);
  expect(String(isolatedPi.calls.sendUserMessage[0][0])).toBe("isolated hello");

  // 模块单例状态完全不受影响
  expect(pi.calls.appendEntry.length).toBe(0);
  expect(pi.calls.sendUserMessage.length).toBe(0);
});

// ---------------------------------------------------------------------------
// B4：会话过期时通过 notifier 提示用户重新登录（不自动拉起二维码）
// ---------------------------------------------------------------------------

test("B4 目标：needs_relogin 时通知用户执行 /wechat login", async () => {
  const isolated = createWechatEngine({
    config: { baseUrl: opts.baseUrl, token: opts.token },
    inbound: inboundMock as never,
    outbound: outboundMock as never,
    media: mediaMock as never,
  });
  const notify = mock((_message: string, _type?: string) => {});
  isolated.setNotifier(notify);

  // 底层返回会话过期错误
  inboundMock.getUpdates.mockImplementation(async () => {
    throw { errcode: -14 };
  });

  await isolated.startPolling(opts);

  expect(notify).toHaveBeenCalledTimes(1);
  expect(String(notify.mock.calls[0][0])).toContain("/wechat login");
  expect(isolated.connectionState).toBe("needs_relogin");
});

// ---------------------------------------------------------------------------
// B6：一进一出、requestId 不串号
// ---------------------------------------------------------------------------

test("B6 目标：终端处理期间连发消息按序排队，排空后 requestId/content 一一对应且不丢", async () => {
  await engine.initSingleUser();
  engine.setHost(pi as never);

  // 模拟 pi 正在处理终端消息：此时所有新消息只能入队
  engine.setTerminalProcessing(true);

  await engine.triggerAi(textMessage("m1"), "r1", opts);
  await engine.triggerAi(textMessage("m2"), "r2", opts);
  await engine.triggerAi(textMessage("m3"), "r3", opts);

  const e = engine as unknown as AnyEngine;
  expect(e.queue.size).toBe(3);

  // 终端处理结束，逐轮通知完成并排空队列
  engine.setTerminalProcessing(false);
  for (let i = 0; i < 3; i++) {
    engine.onAiDone();
    await sleep(60);
  }

  const requestIds = pi.calls.appendEntry
    .filter(([type]) => type === "wechat_meta")
    .map(([, data]) => (data as { requestId: string }).requestId);
  const contents = pi.calls.sendUserMessage.map(([content]) => content);

  expect(requestIds).toEqual(["r1", "r2", "r3"]);
  expect(contents).toEqual(["m1", "m2", "m3"]);
  expect(e.queue.size).toBe(0);
});

// ---------------------------------------------------------------------------
// B5：媒体消息快速 ack + 后台串行下载，不阻塞轮询主循环
// ---------------------------------------------------------------------------

function mediaMessage(contextToken = "CTX-1") {
  return { context_token: contextToken, item_list: [{ type: 2, image_item: {} }] };
}

test("B5 目标：媒体消息立即 ack（不含路径），下载未完成不写 history", async () => {
  await engine.initSingleUser();
  engine.setHost(pi as never);

  let release!: (v: unknown) => void;
  const gate = new Promise<unknown>((res) => {
    release = res;
  });
  mediaMock.download.mockImplementation(async () => {
    await gate;
    return { path: "/tmp/media/2601/pic.png" };
  });

  await engine.handleMessage(mediaMessage(), opts);

  // ack 已发出，且不含保存路径
  expect(outboundMock.sendText).toHaveBeenCalledTimes(1);
  const ack = outboundMock.sendText.mock.calls[0][0] as string;
  expect(ack).toContain("媒体文件已收到");
  expect(ack).not.toContain("/tmp/media");

  // 下载尚未完成：history 未写，且未占用 AI 忙闲标记（不阻塞轮询）
  expect(pi.calls.sendMessage.length).toBe(0);
  expect((engine as unknown as AnyEngine).queue.isBusy()).toBe(false);

  release(undefined);
  await waitFor(() => pi.calls.sendMessage.length > 0);

  const historyMsg = pi.calls.sendMessage[0][0] as {
    customType: string;
    content: string;
    display: boolean;
  };
  expect(historyMsg.customType).toBe("wechat_media");
  expect(historyMsg.display).toBe(false);
  expect(historyMsg.content).toContain("/tmp/media/2601/pic.png");
  expect(pi.calls.sendMessage[0][1]).toEqual({ triggerTurn: false, deliverAs: "followUp" });
});

test("B5 目标：后台媒体任务串行，第 2 条等第 1 条 resolve 后才启动", async () => {
  await engine.initSingleUser();
  engine.setHost(pi as never);

  const resolvers: Array<(v: unknown) => void> = [];
  mediaMock.download.mockImplementation(
    () => new Promise((res) => resolvers.push(res)),
  );

  await engine.handleMessage(mediaMessage(), opts);
  await engine.handleMessage(mediaMessage(), opts);

  // 第 2 条下载尚未启动（串行）
  expect(mediaMock.download).toHaveBeenCalledTimes(1);

  resolvers[0]({ path: "/tmp/media/1.png" });
  await waitFor(() => mediaMock.download.mock.calls.length >= 2);

  resolvers[1]({ path: "/tmp/media/2.png" });
  await waitFor(() => pi.calls.sendMessage.length >= 2);

  const contents = pi.calls.sendMessage.map(([m]) => (m as { content: string }).content);
  expect(contents[0]).toContain("/tmp/media/1.png");
  expect(contents[1]).toContain("/tmp/media/2.png");
});
