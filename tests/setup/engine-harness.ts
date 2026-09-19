/**
 * tests/setup/engine-harness.ts
 *
 * L2 引擎层夹具：
 * - 在导入 wechat.ts 之前，用 mock.module 顶掉它依赖的底层边界模块
 *   （api/api、api/types、messaging/send、messaging/send-media、media/media-download）。
 * - 暴露可控的 mock 对象与便捷的凭证 seed / fake pi。
 *
 * 不读、不改底层模块实现；mock 只在测试运行时生效。
 */
import { mock } from "bun:test";
import { installBaseMocks, repoPath } from "./mocks";

// ---- 可控边界 mock --------------------------------------------------------

export const apiMock = {
  getUpdates: mock(async (_opts: unknown) => ({ msgs: [], get_updates_buf: "" })),
  sendTyping: mock(async (_opts: unknown) => ({})),
  getConfig: mock(async (_opts: unknown) => ({ ret: 0, typing_ticket: "TICKET-1" })),
};

export const sendMock = {
  sendMessageWeixin: mock(async (_opts: unknown) => ({})),
};

export const sendMediaMock = {
  sendWeixinMediaFile: mock(async (_opts: unknown) => ({})),
};

export const mediaMock = {
  downloadMediaFromItem: mock(async (_item: unknown, _opts: unknown) => ({})),
};

/** 与 api/types.ts 的 MessageItemType 对齐（只用到 TEXT）。 */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

let installed = false;

/** 把边界 mock 恢复到默认实现（清空调用记录与自定义返回值）。 */
export function resetBoundaryMocks(): void {
  apiMock.getUpdates.mockReset();
  apiMock.getUpdates.mockImplementation(async () => ({ msgs: [], get_updates_buf: "" }));
  apiMock.sendTyping.mockReset();
  apiMock.sendTyping.mockImplementation(async () => ({}));
  apiMock.getConfig.mockReset();
  apiMock.getConfig.mockImplementation(async () => ({ ret: 0, typing_ticket: "TICKET-1" }));
  sendMock.sendMessageWeixin.mockReset();
  sendMock.sendMessageWeixin.mockImplementation(async () => ({}));
  sendMediaMock.sendWeixinMediaFile.mockReset();
  sendMediaMock.sendWeixinMediaFile.mockImplementation(async () => ({}));
  mediaMock.downloadMediaFromItem.mockReset();
  mediaMock.downloadMediaFromItem.mockImplementation(async () => ({}));
}

export function installEngineMocks(): void {
  installBaseMocks();
  if (installed) return;
  installed = true;

  const apiModule = () => apiMock;
  mock.module(repoPath("api", "api.js"), apiModule);
  mock.module(repoPath("api", "api.ts"), apiModule);

  const typesModule = () => ({ MessageItemType });
  mock.module(repoPath("api", "types.js"), typesModule);
  mock.module(repoPath("api", "types.ts"), typesModule);

  const sendModule = () => sendMock;
  mock.module(repoPath("messaging", "send.js"), sendModule);
  mock.module(repoPath("messaging", "send.ts"), sendModule);

  const sendMediaModule = () => sendMediaMock;
  mock.module(repoPath("messaging", "send-media.js"), sendMediaModule);
  mock.module(repoPath("messaging", "send-media.ts"), sendMediaModule);

  const mediaModule = () => mediaMock;
  mock.module(repoPath("media", "media-download.js"), mediaModule);
  mock.module(repoPath("media", "media-download.ts"), mediaModule);
}

// ---- 被测模块 / 依赖加载 --------------------------------------------------

export async function importEngine() {
  return await import("../../wechat.js");
}

export async function importStorage() {
  return await import("../../storage/state.js");
}

export async function importConfig() {
  return await import("../../config.js");
}

// ---- fake pi --------------------------------------------------------------

export interface EnginePi {
  calls: {
    appendEntry: Array<[string, unknown]>;
    sendUserMessage: Array<[unknown, unknown]>;
    sendMessage: Array<[unknown, unknown]>;
  };
  appendEntry: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
}

export function createEnginePi(): EnginePi {
  const calls: EnginePi["calls"] = { appendEntry: [], sendUserMessage: [], sendMessage: [] };
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

/** 构造一个「第一次返回 batch，之后挂起」的可控 getUpdates。 */
export function controllableGetUpdates() {
  const pendingResolvers: Array<(value: unknown) => void> = [];
  let callCount = 0;
  const impl = (_o: unknown) => {
    callCount += 1;
    if (callCount === 1) {
      return Promise.resolve({ msgs: [], get_updates_buf: "cursor-0" });
    }
    return new Promise((resolve) => {
      pendingResolvers.push(resolve);
    });
  };
  return {
    impl,
    get callCount() {
      return callCount;
    },
    resolveAll(value: unknown) {
      while (pendingResolvers.length > 0) {
        pendingResolvers.shift()!(value);
      }
    },
  };
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
