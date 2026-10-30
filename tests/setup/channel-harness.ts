/**
 * tests/setup/channel-harness.ts
 *
 * L2 通道层夹具：
 * - 只安装与微信无关的基础 mock（pi SDK / typebox / util/logger），
 *   不再对任何 vendor 路径做模块级替换。
 * - 暴露可控的端口 fake（inbound/outbound/media）与便捷的凭证 seed / fake pi。
 * - 测试通过 `new Channel({ state: new ChannelState(), ports: { inbound, outbound, media } })`
 *   注入 fake ports（见 tests/channel/channel.test.ts 的 makeChannel）。
 *
 * 不读、不改底层模块实现；fake 只在测试运行时生效。
 */
import { mock } from "bun:test";
import { installBaseMocks } from "./mocks";
import { MessageItemType } from "../../src/ports/types.js";

// ---- 端口 fake ------------------------------------------------------------

export const inboundMock = {
  getUpdates: mock(async (_params: unknown) => ({ messages: [], cursor: "" })),
};

export const outboundMock = {
  sendText: mock(async (_text: string) => {}),
  sendFile: mock(async (_localPath: string) => {}),
  sendTyping: mock(async (_status: 1 | 2, _ticket: string) => {}),
  getTypingTicket: mock(async () => "TICKET-1" as string | null),
};

export const mediaMock = {
  download: mock(async (_item: unknown, _deps: unknown) => null as { path: string } | null),
};

export { MessageItemType };

/** 把所有端口 fake 恢复到默认实现（清空调用记录与自定义返回值）。 */
export function resetPortMocks(): void {
  inboundMock.getUpdates.mockReset();
  inboundMock.getUpdates.mockImplementation(async () => ({ messages: [], cursor: "" }));

  outboundMock.sendText.mockReset();
  outboundMock.sendText.mockImplementation(async () => {});
  outboundMock.sendFile.mockReset();
  outboundMock.sendFile.mockImplementation(async () => {});
  outboundMock.sendTyping.mockReset();
  outboundMock.sendTyping.mockImplementation(async () => {});
  outboundMock.getTypingTicket.mockReset();
  outboundMock.getTypingTicket.mockImplementation(async () => "TICKET-1");

  mediaMock.download.mockReset();
  mediaMock.download.mockImplementation(async () => null);
}

/** 安装基础 mock（在首次 import 被测源码前调用）。 */
export function installChannelMocks(): void {
  installBaseMocks();
}

// ---- 被测模块 / 依赖加载 --------------------------------------------------

export async function importChannel() {
  return await import("../../src/channel/channel.js");
}

export async function importStorage() {
  return await import("../../src/storage/state.js");
}

export async function importConfig() {
  return await import("../../src/shared/config.js");
}

// ---- fake pi --------------------------------------------------------------

export interface ChannelPi {
  calls: {
    appendEntry: Array<[string, unknown]>;
    sendUserMessage: Array<[unknown, unknown]>;
    sendMessage: Array<[unknown, unknown]>;
  };
  appendEntry: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
}

export function createChannelPi(): ChannelPi {
  const calls: ChannelPi["calls"] = { appendEntry: [], sendUserMessage: [], sendMessage: [] };
  return {
    calls,
    appendEntry: mock((type: string, data: unknown) => {
      calls.appendEntry.push([type, data]);
    }),
    sendUserMessage: mock((content: unknown, opts: unknown) => {
      calls.sendUserMessage.push([content, opts]);
    }),
    sendMessage: mock((msg: unknown, opts: unknown) => {
      calls.sendMessage.push([msg, opts]);
    }),
  };
}

// ---- fixtures & seed ------------------------------------------------------

export const opts = { baseUrl: "https://ilinkai.example.com", token: "bot-token-abc" };

export function textMessage(text: string, contextToken = "CTX-1") {
  return {
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

export async function seedSingleUser(storage: Awaited<ReturnType<typeof importStorage>>) {
  await storage.saveToken("acc1", {
    botToken: "bot-token-abc",
    accountId: "acc1",
    userId: "U1",
    baseUrl: opts.baseUrl,
    loginAt: Date.now(),
  });
  await storage.upsertAccount({ accountId: "acc1", displayName: "微信账号", loginAt: Date.now() });
  await storage.saveContextToken("acc1", "U1", { displayName: "U1", contextToken: "CTX-1" });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待某个条件成立（带超时），用于异步轮询场景。 */
export async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}
