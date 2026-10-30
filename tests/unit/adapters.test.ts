/**
 * tests/unit/adapters.test.ts
 *
 * PA-2：4 个微信侧 adapter 的基线用例。
 *
 * 手法：在动态 import adapter 之前，用 `mock.module` 顶掉 vendor 边界模块
 * （api/api、messaging/send、messaging/send-media、media/media-download、auth/login-qr），
 * 断言 adapter 的映射 / 缓存 / 回调适配 / 字段映射行为。
 *
 * S3 接入 engine 时将改为端口 fake 注入，本阶段先以本文件建立回归基线。
 */
import { mock, test, expect, beforeEach } from "bun:test";
import { repoPath } from "../setup/mocks";

// ---- 可控 vendor 边界 mock -------------------------------------------------

export const apiMock = {
  getUpdates: mock(async (_opts: unknown) => ({ msgs: [], get_updates_buf: "" })),
  getConfig: mock(async (_opts: unknown) => ({ ret: 0, typing_ticket: "TICKET-1" })),
  sendTyping: mock(async (_opts: unknown) => ({})),
};

export const sendMock = {
  sendMessageWeixin: mock(async (_opts: unknown) => ({ messageId: "m1" })),
};

export const sendMediaMock = {
  sendWeixinMediaFile: mock(async (_opts: unknown) => ({ messageId: "m2" })),
};

export const mediaMock = {
  downloadMediaFromItem: mock(async (_item: unknown, _deps: unknown) => ({})),
};

export const authMock = {
  startWeixinLoginWithQr: mock(async (_opts: unknown) => ({
    qrcodeUrl: "https://qr.example/img",
    message: "二维码已就绪",
    sessionKey: "sess-1",
  })),
  waitForWeixinLogin: mock(async (_opts: unknown) => ({
    connected: true,
    message: "连接成功",
  })),
  DEFAULT_ILINK_BOT_TYPE: "3",
};

mock.module(repoPath("api", "api.js"), () => apiMock);
mock.module(repoPath("api", "api.ts"), () => apiMock);
mock.module(repoPath("messaging", "send.js"), () => sendMock);
mock.module(repoPath("messaging", "send.ts"), () => sendMock);
mock.module(repoPath("messaging", "send-media.js"), () => sendMediaMock);
mock.module(repoPath("messaging", "send-media.ts"), () => sendMediaMock);
mock.module(repoPath("media", "media-download.js"), () => mediaMock);
mock.module(repoPath("media", "media-download.ts"), () => mediaMock);
mock.module(repoPath("auth", "login-qr.js"), () => authMock);
mock.module(repoPath("auth", "login-qr.ts"), () => authMock);

// ---- 被测 adapter（必须在 mock.module 之后动态 import）--------------------

const { createWechatInbound } = await import("../../src/adapters/inbound.js");
const { createWechatOutbound } = await import("../../src/adapters/outbound.js");
const { createWechatMedia } = await import("../../src/adapters/media.js");
const { createWechatAuth } = await import("../../src/adapters/auth.js");

// ---- fixtures --------------------------------------------------------------

function makeCreds(overrides: Partial<{
  baseUrl: string;
  token: string;
  userId: string;
  contextToken: string;
}> = {}) {
  return {
    baseUrl: "https://ilinkai.example.com",
    token: "bot-token-abc",
    userId: "U1",
    contextToken: "CTX-1",
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.getUpdates.mockReset();
  apiMock.getUpdates.mockImplementation(async () => ({ msgs: [], get_updates_buf: "" }));
  apiMock.getConfig.mockReset();
  apiMock.getConfig.mockImplementation(async () => ({ ret: 0, typing_ticket: "TICKET-1" }));
  apiMock.sendTyping.mockReset();
  apiMock.sendTyping.mockImplementation(async () => ({}));

  sendMock.sendMessageWeixin.mockReset();
  sendMock.sendMessageWeixin.mockImplementation(async () => ({ messageId: "m1" }));

  sendMediaMock.sendWeixinMediaFile.mockReset();
  sendMediaMock.sendWeixinMediaFile.mockImplementation(async () => ({ messageId: "m2" }));

  mediaMock.downloadMediaFromItem.mockReset();
  mediaMock.downloadMediaFromItem.mockImplementation(async () => ({}));

  authMock.startWeixinLoginWithQr.mockReset();
  authMock.startWeixinLoginWithQr.mockImplementation(async () => ({
    qrcodeUrl: "https://qr.example/img",
    message: "二维码已就绪",
    sessionKey: "sess-1",
  }));
  authMock.waitForWeixinLogin.mockReset();
  authMock.waitForWeixinLogin.mockImplementation(async () => ({
    connected: true,
    message: "连接成功",
  }));
});

// ===========================================================================
// inbound
// ===========================================================================

test("inbound：msgs/get_updates_buf 映射为 messages/cursor，并透传凭证与游标", async () => {
  apiMock.getUpdates.mockResolvedValueOnce({
    msgs: [{ message_id: 1 }, { message_id: 2 }],
    get_updates_buf: "cursor-1",
  });

  const inbound = createWechatInbound();
  const result = await inbound.getUpdates({
    cursor: "cursor-0",
    baseUrl: "https://api.example.com",
    token: "tok",
    timeoutMs: 1234,
  });

  expect(result).toEqual({
    messages: [{ message_id: 1 }, { message_id: 2 }],
    cursor: "cursor-1",
  });
  expect(apiMock.getUpdates).toHaveBeenCalledWith({
    baseUrl: "https://api.example.com",
    token: "tok",
    get_updates_buf: "cursor-0",
    timeoutMs: 1234,
  });
});

test("inbound：响应字段缺失时 messages 回落为空数组、cursor 沿用入参", async () => {
  apiMock.getUpdates.mockResolvedValueOnce({ ret: 0 });

  const inbound = createWechatInbound();
  const result = await inbound.getUpdates({
    cursor: "cursor-keep",
    baseUrl: "https://api.example.com",
    token: "tok",
  });

  expect(result).toEqual({ messages: [], cursor: "cursor-keep" });
});

// ===========================================================================
// outbound：发送
// ===========================================================================

test("outbound：sendText 用注入凭证调用 sendMessageWeixin", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });
  await outbound.sendText("hello");

  expect(sendMock.sendMessageWeixin).toHaveBeenCalledWith({
    to: "U1",
    text: "hello",
    opts: {
      baseUrl: "https://ilinkai.example.com",
      token: "bot-token-abc",
      contextToken: "CTX-1",
    },
  });
});

test("outbound：sendFile 用注入凭证调用 sendWeixinMediaFile（text 空、固定 CDN 基址）", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });
  await outbound.sendFile("/tmp/pic.png");

  expect(sendMediaMock.sendWeixinMediaFile).toHaveBeenCalledWith({
    filePath: "/tmp/pic.png",
    to: "U1",
    text: "",
    opts: {
      baseUrl: "https://ilinkai.example.com",
      token: "bot-token-abc",
      contextToken: "CTX-1",
    },
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
  });
});

test("outbound：凭证缺失时 sendText / sendFile 抛错（保持现行为）", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => null });

  await expect(outbound.sendText("x")).rejects.toThrow("Single user not initialized");
  await expect(outbound.sendFile("/tmp/x")).rejects.toThrow("Single user not initialized");
});

// ===========================================================================
// outbound：typing ticket（端口薄：无缓存）
// ===========================================================================

test("outbound：getTypingTicket 直连 getConfig，不缓存", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });

  expect(await outbound.getTypingTicket()).toBe("TICKET-1");
  expect(await outbound.getTypingTicket()).toBe("TICKET-1");
  expect(apiMock.getConfig).toHaveBeenCalledTimes(2);
});

test("outbound：getTypingTicket 在凭证缺失 / getConfig 失败 / ret!=0 时返回 null", async () => {
  const noCreds = createWechatOutbound({ getCredentials: () => null });
  expect(await noCreds.getTypingTicket()).toBeNull();
  expect(apiMock.getConfig).not.toHaveBeenCalled();

  apiMock.getConfig.mockRejectedValueOnce(new Error("network down"));
  const withCreds = createWechatOutbound({ getCredentials: () => makeCreds() });
  expect(await withCreds.getTypingTicket()).toBeNull();

  apiMock.getConfig.mockResolvedValueOnce({ ret: -1, errmsg: "no ticket" });
  expect(await withCreds.getTypingTicket()).toBeNull();
});

test("outbound：sendTyping(status, ticket) 直接用传入 ticket 调用底层，不取配置", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });

  await outbound.sendTyping(1, "T-EXPLICIT");
  expect(apiMock.sendTyping).toHaveBeenCalledWith({
    baseUrl: "https://ilinkai.example.com",
    token: "bot-token-abc",
    body: { ilink_user_id: "U1", typing_ticket: "T-EXPLICIT", status: 1 },
  });
  // 端口薄：sendTyping 不触发 getConfig
  expect(apiMock.getConfig).not.toHaveBeenCalled();
});

test("outbound：sendTyping 底层抛错时向上冒泡（清缓存由 TypingController 负责）", async () => {
  apiMock.sendTyping.mockRejectedValueOnce(new Error("invalid typing_ticket"));
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });

  await expect(outbound.sendTyping(1, "T-1")).rejects.toThrow("invalid typing_ticket");
});

test("outbound：sendTyping 凭证缺失时直接返回，不调用底层", async () => {
  const outbound = createWechatOutbound({ getCredentials: () => null });
  await outbound.sendTyping(2, "T-1");
  expect(apiMock.sendTyping).not.toHaveBeenCalled();
});

// ===========================================================================
// media：回调适配与路径挑选
// ===========================================================================

test("media：把端口 3 参 saveMedia 适配为 vendor 5 参回调", async () => {
  const saveMedia = mock(async (_b: Buffer, _c?: string, _f?: string) => ({ path: "/saved/file.png" }));

  mediaMock.downloadMediaFromItem.mockImplementationOnce(async (_item: unknown, deps: unknown) => {
    const d = deps as {
      saveMedia: (
        buffer: Buffer,
        contentType?: string,
        subdir?: string,
        maxBytes?: number,
        originalFilename?: string,
      ) => Promise<{ path: string }>;
      label: string;
    };
    const saved = await d.saveMedia(Buffer.from("data"), "image/png", "inbound", 100, "orig.png");
    return { decryptedPicPath: saved.path };
  });

  const media = createWechatMedia();
  const result = await media.download(
    { type: 2 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia, label: "L" },
  );

  expect(result).toEqual({ path: "/saved/file.png" });
  expect(saveMedia).toHaveBeenCalledWith(Buffer.from("data"), "image/png", "orig.png");
  expect(mediaMock.downloadMediaFromItem).toHaveBeenCalledWith(
    { type: 2 },
    expect.objectContaining({ cdnBaseUrl: "https://cdn.example.com", label: "L" }),
  );
});

test("media：按 Pic > Voice > File > Video 取第一个非空路径", async () => {
  mediaMock.downloadMediaFromItem.mockResolvedValueOnce({
    decryptedVoicePath: "/v.silk",
    decryptedFilePath: "/f.pdf",
    decryptedVideoPath: "/vid.mp4",
  });

  const media = createWechatMedia();
  const result = await media.download(
    { type: 3 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia: async () => ({ path: "/unused" }) },
  );

  expect(result).toEqual({ path: "/v.silk" });
});

test("media：image 路径优先于其它类型", async () => {
  mediaMock.downloadMediaFromItem.mockResolvedValueOnce({
    decryptedPicPath: "/pic.jpg",
    decryptedVoicePath: "/v.silk",
  });

  const media = createWechatMedia();
  const result = await media.download(
    { type: 2 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia: async () => ({ path: "/unused" }) },
  );

  expect(result).toEqual({ path: "/pic.jpg" });
});

test("media：无任何 decrypted*Path 时返回 null", async () => {
  mediaMock.downloadMediaFromItem.mockResolvedValueOnce({});

  const media = createWechatMedia();
  const result = await media.download(
    { type: 2 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia: async () => ({ path: "/unused" }) },
  );

  expect(result).toBeNull();
});

test("media：label 缺省时传给 vendor 的 label 为 'media'", async () => {
  mediaMock.downloadMediaFromItem.mockResolvedValueOnce({ decryptedPicPath: "/p" });

  const media = createWechatMedia();
  await media.download(
    { type: 2 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia: async () => ({ path: "/unused" }) },
  );

  expect(mediaMock.downloadMediaFromItem).toHaveBeenCalledWith(
    { type: 2 },
    expect.objectContaining({ label: "media" }),
  );
});

// ===========================================================================
// auth：字段映射
// ===========================================================================

test("auth：startQr 透传字段，botType 缺省时用 DEFAULT_ILINK_BOT_TYPE", async () => {
  const auth = createWechatAuth();
  const result = await auth.startQr({ apiBaseUrl: "https://auth.example.com" });

  expect(authMock.startWeixinLoginWithQr).toHaveBeenCalledWith({
    apiBaseUrl: "https://auth.example.com",
    accountId: undefined,
    botType: "3",
    force: undefined,
    timeoutMs: undefined,
    verbose: undefined,
  });
  expect(result).toEqual({
    qrcodeUrl: "https://qr.example/img",
    message: "二维码已就绪",
    sessionKey: "sess-1",
  });
});

test("auth：startQr 显式 botType/force/accountId 原样透传", async () => {
  const auth = createWechatAuth();
  await auth.startQr({
    apiBaseUrl: "https://auth.example.com",
    accountId: "acc-9",
    botType: "7",
    force: true,
    timeoutMs: 5000,
    verbose: true,
  });

  expect(authMock.startWeixinLoginWithQr).toHaveBeenCalledWith({
    apiBaseUrl: "https://auth.example.com",
    accountId: "acc-9",
    botType: "7",
    force: true,
    timeoutMs: 5000,
    verbose: true,
  });
});

test("auth：waitForLogin 映射 connected/botToken/accountId/baseUrl/userId", async () => {
  authMock.waitForWeixinLogin.mockResolvedValueOnce({
    connected: true,
    message: "ok",
    botToken: "bt",
    accountId: "acc-1",
    baseUrl: "https://base.example.com",
    userId: "U9",
  });

  const auth = createWechatAuth();
  const result = await auth.waitForLogin({
    sessionKey: "sess-1",
    apiBaseUrl: "https://auth.example.com",
  });

  expect(result).toEqual({
    connected: true,
    message: "ok",
    botToken: "bt",
    accountId: "acc-1",
    baseUrl: "https://base.example.com",
    userId: "U9",
  });
  expect(authMock.waitForWeixinLogin).toHaveBeenCalledWith({
    sessionKey: "sess-1",
    apiBaseUrl: "https://auth.example.com",
    botType: "3",
    timeoutMs: undefined,
    verbose: undefined,
  });
});

test("auth：waitForLogin 未连接时保留 connected=false 与 message", async () => {
  authMock.waitForWeixinLogin.mockResolvedValueOnce({
    connected: false,
    message: "登录超时",
  });

  const auth = createWechatAuth();
  const result = await auth.waitForLogin({
    sessionKey: "sess-2",
    apiBaseUrl: "https://auth.example.com",
    botType: "7",
  });

  expect(result).toEqual({
    connected: false,
    message: "登录超时",
    botToken: undefined,
    accountId: undefined,
    baseUrl: undefined,
    userId: undefined,
  });
});

// ===========================================================================
// 端口冻结 / ACL 契约
// ===========================================================================

test("端口冻结：WechatOutbound 方法参数面（sendFile 不得加 to）", () => {
  const outbound = createWechatOutbound({ getCredentials: () => makeCreds() });

  expect(outbound.sendText.length).toBe(1);
  expect(outbound.sendFile.length).toBe(1);
  expect(outbound.sendTyping.length).toBe(2);
  expect(outbound.getTypingTicket.length).toBe(0);
});

test("端口冻结：WechatMedia / WechatInbound / WechatAuth 方法参数面", () => {
  const media = createWechatMedia();
  const inbound = createWechatInbound();
  const auth = createWechatAuth();

  expect(media.download.length).toBe(2);
  expect(inbound.getUpdates.length).toBe(1);
  expect(auth.startQr.length).toBe(1);
  expect(auth.waitForLogin.length).toBe(1);
});

test("ACL 契约：vendor 5 参 saveMedia → 端口仅收到 3 参，subdir/maxBytes 不泄漏", async () => {
  const saveMedia = mock(async (_b: Buffer, _c?: string, _f?: string) => ({ path: "/saved/acl.png" }));

  mediaMock.downloadMediaFromItem.mockImplementationOnce(async (_item: unknown, deps: unknown) => {
    const d = deps as {
      saveMedia: (
        buffer: Buffer,
        contentType?: string,
        subdir?: string,
        maxBytes?: number,
        originalFilename?: string,
      ) => Promise<{ path: string }>;
    };
    // 模拟 vendor：以 5 参调用（subdir="inbound" / maxBytes=100 / originalFilename="orig.png"）
    const saved = await d.saveMedia(Buffer.from("acl"), "image/png", "inbound", 100, "orig.png");
    return { decryptedPicPath: saved.path };
  });

  const media = createWechatMedia();
  const result = await media.download(
    { type: 2 },
    { cdnBaseUrl: "https://cdn.example.com", saveMedia, label: "ACL" },
  );

  expect(result).toEqual({ path: "/saved/acl.png" });
  expect(saveMedia.mock.calls.length).toBe(1);
  // 端口 saveMedia 只收到 3 参：subdir / maxBytes 被 adapter 有意丢弃
  expect(saveMedia.mock.calls[0].length).toBe(3);
  expect(saveMedia.mock.calls[0][0]).toEqual(Buffer.from("acl"));
  expect(saveMedia.mock.calls[0][1]).toBe("image/png");
  expect(saveMedia.mock.calls[0][2]).toBe("orig.png");
});
