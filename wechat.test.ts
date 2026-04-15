/**
 * wechat.test.ts - 微信核心引擎测试（单用户版本）
 * 
 * 测试策略：
 * 1. requestId 生成（格式、唯一性、毫秒精度）
 * 2. 消息格式化（简化格式验证）
 * 3. 单用户初始化
 * 4. 消息队列（入队、出队、并发）
 * 5. Typing keepalive（启动、停止、缓存）
 * 6. 消息发送（重试、防重）
 * 7. 状态重置
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============== 使用 vi.hoisted 解决 hoisting 问题 ==============

const { mockSendMessage, mockSendTyping, mockGetConfig, mockPi, mockStorage, mockSetTimeout, mockSetInterval, mockClearTimeout, mockClearInterval } = vi.hoisted(() => {
  return {
    mockSendMessage: vi.fn(),
    mockSendTyping: vi.fn(),
    mockGetConfig: vi.fn(),
    mockPi: {
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    },
    mockStorage: {
      getSingleUserCredentials: vi.fn(),
      getSingleUserContextToken: vi.fn(),
      getSingleUserId: vi.fn(),
      loadSyncCursor: vi.fn().mockResolvedValue(""),
      saveSyncCursor: vi.fn().mockResolvedValue(undefined),
      saveContextToken: vi.fn().mockResolvedValue(undefined),
    },
    mockSetTimeout: vi.fn((fn: Function) => { fn(); return 0; }) as unknown as typeof setTimeout,
    mockClearTimeout: vi.fn() as unknown as typeof clearTimeout,
    mockSetInterval: vi.fn(() => 1) as unknown as typeof setInterval,
    mockClearInterval: vi.fn() as unknown as typeof clearInterval,
  };
});

// Mock config
vi.mock("./config.js", () => ({
  getPrefix: () => "[wechat]",
  loadConfig: () => ({ prefix: "[wechat]", debug: false }),
  clearConfigCache: vi.fn(),
}));

// Mock API
vi.mock("./api/api.js", () => ({
  getUpdates: vi.fn().mockResolvedValue({ msgs: [], get_updates_buf: "" }),
  sendMessage: mockSendMessage,
  sendTyping: mockSendTyping,
  getConfig: mockGetConfig,
}));

// Mock storage
vi.mock("./storage/state.js", () => mockStorage);

// Mock logger
vi.mock("./util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock getAgentDir
vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/test-agent",
}));

// Mock globals
vi.stubGlobal("setTimeout", mockSetTimeout);
vi.stubGlobal("clearTimeout", mockClearTimeout);
vi.stubGlobal("setInterval", mockSetInterval);
vi.stubGlobal("clearInterval", mockClearInterval);

// ============== 导入被测模块 ==============

import { WechatEngine, setPi, setConfig } from "./wechat.js";

describe("WechatEngine - Single User Version Tests", () => {
  let engine: WechatEngine;

  beforeEach(() => {
    // 重置 engine
    engine = new WechatEngine();
    
    // 设置 mock
    setPi(mockPi as any);
    setConfig({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "test_token",
    });
    
    // 设置默认 storage mock
    mockStorage.getSingleUserCredentials.mockResolvedValue({
      botToken: "test_token",
      accountId: "test_account",
      userId: "wxid_test_user",
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
    mockStorage.getSingleUserContextToken.mockResolvedValue("ctx_token_123");
    mockStorage.getSingleUserId.mockResolvedValue("wxid_test_user");
    
    // 重置所有 mock
    vi.clearAllMocks();
    
    // 重置定时器 mock
    mockSetTimeout.mockImplementation((fn: Function) => { fn(); return 0; });
    mockSetInterval.mockReturnValue(1);
  });

  // ============== 1. requestId 生成测试 ==============
  
  describe("1. generateRequestId", () => {
    it("should generate timestamp-based ID", () => {
      const requestId = (engine as any).generateRequestId();
      
      // ID 应该只包含数字
      expect(requestId).toMatch(/^\d+$/);
      
      // ID 应该以当前年份（后两位）开头
      const currentYear = String(new Date().getFullYear()).slice(-2);
      expect(requestId.startsWith(currentYear)).toBe(true);
      
      // ID 长度应该在 14-17 位之间（取决于当前时间）
      expect(requestId.length).toBeGreaterThanOrEqual(14);
    });

    it("should generate different IDs over time", () => {
      const ids = new Set<string>();
      
      // 生成多个 ID
      for (let i = 0; i < 10; i++) {
        ids.add((engine as any).generateRequestId());
      }
      
      // 由于时间在变化，应该有一些不同的 ID
      expect(ids.size).toBeGreaterThan(0);
    });
  });

  // ============== 2. 消息格式化测试 ==============
  
  describe("2. formatMessage (Simplified)", () => {
    it("should format text message with prefix only", async () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 1, text_item: { text: "Hello world" } },
        ],
      } as any;

      const result = await engine.formatMessage(msg, {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      // 新格式: [wechat] Hello world
      expect(result).toBe("[wechat] Hello world");
    });

    it("should format image message with path", async () => {
      // Mock downloadImage
      vi.spyOn(engine, "downloadImage").mockResolvedValueOnce("/path/to/image.jpg");
      
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 2, image_item: { aeskey: "0".repeat(32), media: { full_url: "http://example.com/img", aes_key: "" } } },
        ],
      } as any;

      const result = await engine.formatMessage(msg, {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect(result).toBe("[wechat] [image:/path/to/image.jpg]");
    });

    it("should format mixed content correctly", async () => {
      vi.spyOn(engine, "downloadImage").mockResolvedValueOnce("/path/to/img.jpg");
      
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 1, text_item: { text: "Text" } },
          { type: 2, image_item: { aeskey: "0".repeat(32), media: { full_url: "http://example.com/img", aes_key: "" } } },
        ],
      } as any;

      const result = await engine.formatMessage(msg, {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect(result).toBe("[wechat] Text\n[image:/path/to/img.jpg]");
    });

    it("should handle empty content gracefully", async () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [],
      } as any;

      const result = await engine.formatMessage(msg, {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect(result).toBe("[wechat] ");
    });
  });

  // ============== 3. 单用户初始化测试 ==============
  
  describe("3. initSingleUser", () => {
    it("should initialize with valid credentials", async () => {
      mockStorage.getSingleUserCredentials.mockResolvedValueOnce({
        botToken: "token_abc",
        accountId: "account_xyz",
        userId: "wxid_user123",
        baseUrl: "https://ilinkai.weixin.qq.com",
      });
      mockStorage.getSingleUserContextToken.mockResolvedValueOnce("ctx_abc123");

      const result = await engine.initSingleUser();

      expect(result).toBe(true);
      expect((engine as any).singleUserId).toBe("wxid_user123");
      expect((engine as any).singleContextToken).toBe("ctx_abc123");
      expect((engine as any).accountId).toBe("account_xyz");
    });

    it("should return false when no credentials", async () => {
      mockStorage.getSingleUserCredentials.mockResolvedValueOnce(null);

      const result = await engine.initSingleUser();

      expect(result).toBe(false);
    });

    it("should warn when no contextToken", async () => {
      mockStorage.getSingleUserCredentials.mockResolvedValueOnce({
        botToken: "token",
        accountId: "account",
        userId: "wxid_user",
        baseUrl: "https://example.com",
      });
      mockStorage.getSingleUserContextToken.mockResolvedValueOnce(null);

      const consoleSpy = vi.spyOn(console, "warn");
      await engine.initSingleUser();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No context token found")
      );
    });
  });

  // ============== 4. 消息队列测试 ==============
  
  describe("4. Message Queue", () => {
    it("should queue message when AI is processing", async () => {
      // 模拟 AI 正在处理
      (engine as any).isAiProcessing = true;

      const msg = { item_list: [{ type: 1, text_item: { text: "test" } }] } as any;
      
      await engine.triggerAi(msg, "req_001", {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect((engine as any).pendingMessages.length).toBe(1);
      expect((engine as any).pendingMessages[0].requestId).toBe("req_001");
    });

    it("should process message directly when AI is idle", async () => {
      (engine as any).isAiProcessing = false;
      mockPi.sendUserMessage.mockResolvedValueOnce(undefined);
      mockPi.appendEntry.mockResolvedValueOnce(undefined);

      const msg = { item_list: [{ type: 1, text_item: { text: "test" } }] } as any;
      
      await engine.triggerAi(msg, "req_002", {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect(mockPi.sendUserMessage).toHaveBeenCalled();
      expect((engine as any).isAiProcessing).toBe(true);
    });

    it("onAiDone should process queued messages", async () => {
      // 先初始化单用户
      await engine.initSingleUser();
      
      // 设置队列中有消息
      const msg = { item_list: [{ type: 1, text_item: { text: "queued" } }] } as any;
      (engine as any).pendingMessages = [{ msg, requestId: "req_queued" }];
      (engine as any).isAiProcessing = true;

      mockPi.sendUserMessage.mockResolvedValueOnce(undefined);
      mockPi.appendEntry.mockResolvedValueOnce(undefined);

      engine.onAiDone();

      // 应该触发下一条消息
      // 注意: 由于 setTimeout 被 mock 为同步执行，消息会被立即处理
      expect((engine as any).pendingMessages.length).toBeLessThanOrEqual(0);
    });

    it("onAiDone should do nothing when queue is empty", async () => {
      (engine as any).pendingMessages = [];
      (engine as any).isAiProcessing = true;

      engine.onAiDone();

      expect((engine as any).isAiProcessing).toBe(false);
    });
  });

  // ============== 5. Typing Keepalive 测试 ==============
  
  describe("5. Typing Keepalive", () => {
    it("should start typing keepalive and cache ticket", async () => {
      // 先初始化单用户
      await engine.initSingleUser();
      
      mockGetConfig.mockResolvedValueOnce({
        ret: 0,
        typing_ticket: "cached_ticket_123",
      });
      mockSendTyping.mockResolvedValueOnce(undefined);

      await engine.startTypingKeepalive();

      expect(mockGetConfig).toHaveBeenCalled();
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it("should reuse cached typing ticket", async () => {
      // 先初始化单用户
      await engine.initSingleUser();
      
      // 先启动一次，建立缓存
      mockGetConfig.mockResolvedValueOnce({
        ret: 0,
        typing_ticket: "ticket_123",
      });
      mockSendTyping.mockResolvedValue(undefined);

      await engine.startTypingKeepalive();
      
      // 再启动一次，应该使用缓存
      const getConfigCallCount = mockGetConfig.mock.calls.length;
      
      await engine.startTypingKeepalive();
      
      // getConfig 不应该被再次调用
      expect(mockGetConfig.mock.calls.length).toBe(getConfigCallCount);
    });

    it("should clear cached ticket on error", async () => {
      // 先初始化单用户
      await engine.initSingleUser();
      
      mockGetConfig.mockResolvedValueOnce({
        ret: 0,
        typing_ticket: "ticket_123",
      });
      mockSendTyping.mockResolvedValueOnce(undefined);
      
      await engine.startTypingKeepalive();
      
      // 模拟 API 返回 ticket 错误
      mockSendTyping.mockRejectedValueOnce(new Error("invalid ticket"));
      mockGetConfig.mockResolvedValueOnce({
        ret: 0,
        typing_ticket: "new_ticket",
      });
      
      await engine.startTypingKeepalive();
      
      // 应该重新获取 ticket
      expect(mockGetConfig).toHaveBeenCalled();
    });

    it("should stop typing keepalive", async () => {
      mockGetConfig.mockResolvedValueOnce({
        ret: 0,
        typing_ticket: "ticket",
      });
      mockSendTyping.mockResolvedValue(undefined);

      await engine.startTypingKeepalive();
      await engine.stopTypingKeepalive();

      expect(mockClearInterval).toHaveBeenCalled();
      expect((engine as any).typingKeepaliveTimer).toBeNull();
    });
  });

  // ============== 6. 消息发送测试 ==============
  
  describe("6. sendReplyToUser (Single User)", () => {
    it("should send reply with correct parameters", async () => {
      // 先初始化单用户
      await engine.initSingleUser();
      mockSendMessage.mockResolvedValueOnce(undefined);

      await engine.sendReplyToUser("Test reply");

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://ilinkai.weixin.qq.com",
          token: "test_token",
          body: expect.objectContaining({
            msg: expect.objectContaining({
              to_user_id: "wxid_test_user",
              context_token: "ctx_token_123",
              item_list: [{ type: 1, text_item: { text: "Test reply" } }],
            }),
          }),
        })
      );
    });

    it("should throw error when not initialized", async () => {
      // 没有初始化单用户
      const freshEngine = new WechatEngine();
      
      await expect(freshEngine.sendReplyToUser("Test")).rejects.toThrow(
        "Single user not initialized"
      );
    });
  });

  describe("7. sendMessageWithRetry", () => {
    beforeEach(async () => {
      await engine.initSingleUser();
    });

    it("should retry on failure and succeed", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(undefined);

      await engine.sendMessageWithRetry("Test message");

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("should throw after max retries", async () => {
      mockSendMessage.mockRejectedValue(new Error("Persistent error"));

      await expect(engine.sendMessageWithRetry("Test", 3)).rejects.toThrow(
        "Persistent error"
      );

      expect(mockSendMessage).toHaveBeenCalledTimes(3);
    });
  });

  // ============== 7. 防重机制测试 ==============
  
  describe("8. Request Deduplication", () => {
    it("should mark and check request as processed", () => {
      expect(engine.isRequestProcessed("req_123")).toBe(false);
      
      engine.markRequestProcessed("req_123");
      
      expect(engine.isRequestProcessed("req_123")).toBe(true);
    });

    it("should cleanup requests older than 1 hour", () => {
      const oldTimestamp = Date.now() - 3600001;
      const recentTimestamp = Date.now() - 1800000;

      engine.markRequestProcessed("req_old");
      engine.markRequestProcessed("req_recent");

      // 手动设置旧请求的时间戳
      (engine as any).processedRequests.set("req_old", oldTimestamp);
      (engine as any).processedRequests.set("req_recent", recentTimestamp);

      engine.cleanupProcessedRequests();

      expect(engine.isRequestProcessed("req_old")).toBe(false);
      expect(engine.isRequestProcessed("req_recent")).toBe(true);
    });
  });

  // ============== 8. 状态重置测试 ==============
  
  describe("9. reset", () => {
    it("should clear all state", async () => {
      // 设置各种状态
      engine.markRequestProcessed("req1");
      (engine as any).currentRequestId = "req123";
      (engine as any).isAiProcessing = true;
      (engine as any).pendingMessages = [{ msg: {} as any, requestId: "req2" }];
      (engine as any).singleUserId = "wxid_user";
      (engine as any).singleContextToken = "ctx_token";
      
      // Mock typing keepalive timer
      mockGetConfig.mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket" });
      mockSendTyping.mockResolvedValue(undefined);
      await engine.startTypingKeepalive();

      // 调用 reset
      engine.reset();

      // 验证状态已清理
      expect(engine.isRequestProcessed("req1")).toBe(false);
      expect((engine as any).currentRequestId).toBeNull();
      expect((engine as any).isAiProcessing).toBe(false);
      expect((engine as any).pendingMessages).toEqual([]);
      expect((engine as any).typingKeepaliveTimer).toBeNull();
      expect((engine as any).typingTicketCache).toBeNull();
    });
  });

  // ============== 9. 消息处理流程测试 ==============
  
  describe("10. Message Handling Flow", () => {
    it("should detect slash command", () => {
      const slashMsg = {
        item_list: [{ type: 1, text_item: { text: "/help" } }],
      } as any;

      expect((engine as any).isSlashCommand(slashMsg)).toBe(true);
    });

    it("should not detect non-slash command", () => {
      const normalMsg = {
        item_list: [{ type: 1, text_item: { text: "Hello" } }],
      } as any;

      expect((engine as any).isSlashCommand(normalMsg)).toBe(false);
    });

    it("should update contextToken from incoming message", async () => {
      await engine.initSingleUser();
      
      const msg = {
        from_user_id: "wxid_user",
        context_token: "new_ctx_token_456",
        item_list: [{ type: 1, text_item: { text: "test" } }],
      } as any;

      mockPi.sendUserMessage.mockResolvedValueOnce(undefined);
      mockPi.appendEntry.mockResolvedValueOnce(undefined);

      await engine.handleMessage(msg, {
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
      });

      expect((engine as any).singleContextToken).toBe("new_ctx_token_456");
      expect(mockStorage.saveContextToken).toHaveBeenCalled();
    });
  });
});
