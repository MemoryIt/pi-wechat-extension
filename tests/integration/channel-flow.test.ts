/**
 * tests/integration/channel-flow.test.ts
 *
 * L4 通道集成：**假 pi 宿主（PiHost 探针）+ 真 Channel + 假端口**（inbound/outbound/media）
 * + 真实 storage（installBaseMocks 把 agentDir 固定到临时目录）。
 *
 * 本测试不替换任何微信 vendor 边界（api/messaging/media），
 * 全部经 `ChannelDeps.ports` 注入 fake，真实穿过 Channel 的编排逻辑。
 */
import { test, expect, mock, beforeEach } from "bun:test";
import { installBaseMocks, resetAgentDir } from "../setup/mocks";

// 必须在首次 import 被测源码前安装基础 mock（仅固定 getAgentDir / typebox / util logger）。
installBaseMocks();

const { Channel } = await import("../../src/channel/channel.js");
const { MessageItemType } = await import("../../src/ports/types.js");
const storage = await import("../../src/storage/state.js");

const opts = { baseUrl: "https://ilinkai.example.com", token: "bot-token-abc" };

// ---- 假 pi 宿主（PiHost 探针）-------------------------------------------

interface HostCalls {
  appendEntry: Array<[string, unknown]>;
  sendUserMessage: Array<[unknown, unknown]>;
  sendMessage: Array<[unknown, unknown]>;
}

function createFakeHost() {
  const calls: HostCalls = { appendEntry: [], sendUserMessage: [], sendMessage: [] };
  const host = {
    appendEntry: mock((type: string, data: unknown) => {
      calls.appendEntry.push([type, data]);
    }),
    sendUserMessage: mock((content: unknown, o: unknown) => {
      calls.sendUserMessage.push([content, o]);
    }),
    sendMessage: mock((message: unknown, o: unknown) => {
      calls.sendMessage.push([message, o]);
    }),
  };
  return { host, calls };
}

// ---- 假端口 --------------------------------------------------------------

function makePorts() {
  return {
    inbound: {
      getUpdates: mock(async (_params: unknown) => ({ messages: [], cursor: "" })),
    },
    outbound: {
      sendText: mock(async (_text: string) => {}),
      sendFile: mock(async (_localPath: string) => {}),
      sendTyping: mock(async (_status: 1 | 2, _ticket: string) => {}),
      getTypingTicket: mock(async () => "TICKET-1" as string | null),
    },
    media: {
      download: mock(async (_item: unknown, _deps: unknown): Promise<{ path: string } | null> => null),
    },
  };
}

type Ports = ReturnType<typeof makePorts>;

let ports: Ports;
let fakeHost: ReturnType<typeof createFakeHost>;
let channel: InstanceType<typeof Channel>;

function textMessage(text: string, contextToken = "CTX-1") {
  return {
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

function mediaMessage(contextToken = "CTX-1") {
  return {
    context_token: contextToken,
    item_list: [{ type: MessageItemType.IMAGE, image_item: {} }],
  };
}

async function seedSingleUser() {
  await storage.saveToken("acc1", {
    botToken: opts.token,
    accountId: "acc1",
    userId: "U1",
    baseUrl: opts.baseUrl,
    loginAt: Date.now(),
  });
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });
  await storage.saveContextToken("acc1", "U1", { displayName: "U1", contextToken: "CTX-1" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

beforeEach(async () => {
  resetAgentDir();
  fakeHost = createFakeHost();
  ports = makePorts();
  channel = new Channel({ host: fakeHost.host, config: opts, ports });
  await seedSingleUser();
});

// ---------------------------------------------------------------------------
// 入站文本
// ---------------------------------------------------------------------------

test("入站文本：handleMessage 写 wechat_meta + sendUserMessage；onAiDone 释放并排空队列", async () => {
  await channel.handleMessage(textMessage("hello"), opts);

  expect(fakeHost.calls.appendEntry).toHaveLength(1);
  expect(fakeHost.calls.appendEntry[0][0]).toBe("wechat_meta");
  expect(fakeHost.calls.appendEntry[0][1]).toEqual({ requestId: channel.getCurrentRequestId() });
  expect(fakeHost.calls.sendUserMessage).toHaveLength(1);
  expect(fakeHost.calls.sendUserMessage[0][0]).toBe("hello");
  expect(fakeHost.calls.sendUserMessage[0][1]).toEqual({ deliverAs: "followUp" });
  // 已交给 agent：保持 busy 等待 onAiDone
  expect(channel.getCurrentRequestId()).not.toBeNull();

  // 忙时第二条入队；onAiDone 后释放并排空
  await channel.handleMessage(textMessage("second"), opts);
  expect((channel as unknown as { queue: { size: number } }).queue.size).toBe(1);

  channel.onAiDone();
  expect(channel.getCurrentRequestId()).toBeNull();
  await waitFor(() => fakeHost.calls.sendUserMessage.length === 2);
  expect(fakeHost.calls.sendUserMessage[1][0]).toBe("second");
});

// ---------------------------------------------------------------------------
// 入站媒体
// ---------------------------------------------------------------------------

test("入站媒体：立即 ack；后台串行下载完成后写 wechat_media history", async () => {
  let release!: (v: unknown) => void;
  const gate = new Promise<unknown>((res) => {
    release = res;
  });
  ports.media.download.mockImplementation(async () => {
    await gate;
    return { path: "/tmp/media/2601/pic.png" };
  });

  await channel.handleMessage(mediaMessage(), opts);

  // 立即 ack（不含保存路径），且不占用忙闲
  expect(ports.outbound.sendText).toHaveBeenCalledTimes(1);
  const ack = ports.outbound.sendText.mock.calls[0][0] as string;
  expect(ack).toContain("媒体文件已收到");
  expect(ack).not.toContain("/tmp/media");
  expect(fakeHost.calls.sendMessage).toHaveLength(0);
  expect((channel as unknown as { queue: { isBusy(): boolean } }).queue.isBusy()).toBe(false);

  // 放行下载：端口 download 被调用，后台写入 wechat_media
  release(undefined);
  await waitFor(() => fakeHost.calls.sendMessage.length > 0);

  expect(ports.media.download).toHaveBeenCalledTimes(1);
  const [payload, callOpts] = fakeHost.calls.sendMessage[0];
  expect((payload as { customType: string }).customType).toBe("wechat_media");
  expect((payload as { display: boolean }).display).toBe(false);
  expect((payload as { content: string }).content).toContain("/tmp/media/2601/pic.png");
  expect(callOpts).toEqual({ triggerTurn: false, deliverAs: "followUp" });
});

// ---------------------------------------------------------------------------
// typing
// ---------------------------------------------------------------------------

test("typing：startTyping → sendTyping(1, ticket)；stopTyping 停止 keepalive", async () => {
  await channel.initSession();

  await channel.startTyping();

  expect(ports.outbound.getTypingTicket).toHaveBeenCalledTimes(1);
  expect(ports.outbound.sendTyping).toHaveBeenCalledWith(1, "TICKET-1");

  await channel.stopTyping();

  // 停止后 keepalive 不再触发新的 sendTyping
  const before = ports.outbound.sendTyping.mock.calls.length;
  await sleep(30);
  expect(ports.outbound.sendTyping.mock.calls.length).toBe(before);
});

// ---------------------------------------------------------------------------
// 出站
// ---------------------------------------------------------------------------

test("出站：sendReply → outbound.sendText；sendFile → outbound.sendFile", async () => {
  await channel.initSession();

  await channel.sendReply("hi");
  expect(ports.outbound.sendText).toHaveBeenCalledWith("hi");

  await channel.sendFile("/tmp/sample.pptx");
  expect(ports.outbound.sendFile).toHaveBeenCalledWith("/tmp/sample.pptx");
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test("reset：清凭证但不影响 config/host/notifier", async () => {
  await channel.initSession();
  const notifier = mock((_message: string, _type?: string) => {});
  channel.setNotifier(notifier);

  await channel.sendReply("before");
  expect(ports.outbound.sendText).toHaveBeenCalledWith("before");

  channel.reset();

  // 凭证已清：再次发送入口即抛错，且未触碰底层端口
  const sentBefore = ports.outbound.sendText.mock.calls.length;
  await expect(channel.sendReply("after")).rejects.toThrow("Single user not initialized");
  expect(ports.outbound.sendText.mock.calls.length).toBe(sentBefore);

  // config/host/notifier 保留
  const state = (channel as unknown as {
    state: { config: unknown; host: unknown; notifier: unknown };
  }).state;
  expect(state.config).not.toBeNull();
  expect(state.host).not.toBeNull();
  expect(state.notifier).toBe(notifier);

  // host 仍可用：入站文本仍能交给宿主
  await channel.handleMessage(textMessage("still works"), opts);
  expect(fakeHost.calls.sendUserMessage.at(-1)?.[0]).toBe("still works");
});
