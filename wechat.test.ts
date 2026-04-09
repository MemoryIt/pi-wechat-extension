/**
 * Phase 3c 功能测试
 * 
 * 测试内容：
 * 1. sendMessageWithRetry - 消息发送重试
 * 2. cleanupProcessedRequests - 清理旧请求
 * 3. isRequestProcessed / markRequestProcessed - 防重
 * 4. reset - 状态重置
 * 5. formatWechatMessage - 消息格式化
 * 6. sendTypingStatus - typing 状态
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============ 使用 vi.hoisted 解决 hoisting 问题 ============
const { mockSendMessage, mockSendTyping, mockPi } = vi.hoisted(() => {
  return {
    mockSendMessage: vi.fn(),
    mockSendTyping: vi.fn(),
    mockPi: {
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
    },
  };
});

// Mock wechat.ts 中的依赖
vi.mock("./api/api", () => ({
  getUpdates: vi.fn().mockResolvedValue({ msgs: [], get_updates_buf: "" }),
  sendMessage: mockSendMessage,
  sendTyping: mockSendTyping,
}));

vi.mock("./storage/state.js", () => ({
  loadSyncCursor: vi.fn().mockResolvedValue(""),
  saveSyncCursor: vi.fn().mockResolvedValue(undefined),
  getDefaultAccountToken: vi.fn().mockResolvedValue({
    accountId: "test_account",
    botToken: "test_token",
    baseUrl: "https://ilinkai.weixin.qq.com",
  }),
}));

// Mock sleep
vi.spyOn(global, "setTimeout").mockImplementation((fn: Function) => {
  fn();
  return 0 as any;
});

// ============ 导入被测模块 ============
// 注意：由于 wechat.ts 依赖 pi 实例，需要先 setPi
import { WechatEngine, setPi, setConfig } from "./wechat.js";

describe("Phase 3c: 回复发送功能测试", () => {
  let engine: WechatEngine;

  beforeEach(() => {
    // 重置 engine
    engine = new WechatEngine();
    
    // 设置 mock pi
    setPi(mockPi as any);
    
    // 设置 wechat config
    setConfig({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "test_token",
    });

    // 重置所有 mock
    vi.clearAllMocks();
  });

  describe("1. sendMessageWithRetry", () => {
    it("should send message successfully on first attempt", async () => {
      mockSendMessage.mockResolvedValueOnce(undefined);

      await engine.sendMessageWithRetry(
        "user123",
        "ctx_token",
        "Hello World"
      );

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      
      // 验证调用参数（client_id 是动态 UUID，只验证存在）
      const callArgs = mockSendMessage.mock.calls[0][0];
      expect(callArgs.baseUrl).toBe("https://ilinkai.weixin.qq.com");
      expect(callArgs.token).toBe("test_token");
      expect(callArgs.body.msg.to_user_id).toBe("user123");
      expect(callArgs.body.msg.context_token).toBe("ctx_token");
      expect(callArgs.body.msg.from_user_id).toBe("");  // 必须为空
      expect(callArgs.body.msg.message_type).toBe(2);   // BOT
      expect(callArgs.body.msg.message_state).toBe(2);  // FINISH
      expect(callArgs.body.msg.client_id).toMatch(/^[0-9a-f-]{36}$/); // UUID 格式
      expect(callArgs.body.msg.item_list).toEqual([{ type: 1, text_item: { text: "Hello World" } }]);
    });

    it("should retry on failure and eventually succeed", async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Network error"))
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(undefined);

      await engine.sendMessageWithRetry(
        "user123",
        "ctx_token",
        "Hello World"
      );

      expect(mockSendMessage).toHaveBeenCalledTimes(3);
    });

    it("should throw after max retries", async () => {
      mockSendMessage.mockRejectedValue(new Error("Persistent error"));

      await expect(
        engine.sendMessageWithRetry("user123", "ctx_token", "Hello", 3)
      ).rejects.toThrow("Persistent error");

      expect(mockSendMessage).toHaveBeenCalledTimes(3);
    });
  });

  describe("2. cleanupProcessedRequests", () => {
    it("should clean up requests older than 1 hour", () => {
      const oldTimestamp = Date.now() - 3600001; // 1小时多1毫秒
      const recentTimestamp = Date.now() - 1800000; // 30分钟前

      // 通过 markRequestProcessed 添加一些请求
      engine.markRequestProcessed("req_old_1");
      engine.markRequestProcessed("req_old_2");
      engine.markRequestProcessed("req_recent_1");

      // 手动设置时间（模拟旧请求）
      (engine as any).processedRequests.set("req_old_1", oldTimestamp);
      (engine as any).processedRequests.set("req_old_2", oldTimestamp);
      (engine as any).processedRequests.set("req_recent_1", recentTimestamp);

      engine.cleanupProcessedRequests();

      expect(engine.isRequestProcessed("req_old_1")).toBe(false);
      expect(engine.isRequestProcessed("req_old_2")).toBe(false);
      expect(engine.isRequestProcessed("req_recent_1")).toBe(true);
    });
  });

  describe("3. isRequestProcessed / markRequestProcessed", () => {
    it("should return false for new request", () => {
      expect(engine.isRequestProcessed("new_request")).toBe(false);
    });

    it("should return true after marking as processed", () => {
      engine.markRequestProcessed("test_request");
      expect(engine.isRequestProcessed("test_request")).toBe(true);
    });

    it("should not process same request twice", () => {
      engine.markRequestProcessed("dup_request");
      
      // 第一次检查
      expect(engine.isRequestProcessed("dup_request")).toBe(true);
      
      // 重复标记（计数器应该增加）
      engine.markRequestProcessed("dup_request");
      expect(engine.isRequestProcessed("dup_request")).toBe(true);
    });
  });

  describe("4. reset", () => {
    it("should clear all state", () => {
      // 设置一些状态
      engine.markRequestProcessed("req1");
      (engine as any).currentUserId = "user123";
      (engine as any).currentRequestId = "req123";
      (engine as any).isAiProcessing = true;
      (engine as any).pendingMessages.set("user123", []);

      // 调用 reset
      engine.reset();

      // 验证状态已清理
      expect(engine.isRequestProcessed("req1")).toBe(false);
      expect((engine as any).currentUserId).toBe(null);
      expect((engine as any).currentRequestId).toBe(null);
      expect((engine as any).isAiProcessing).toBe(false);
      expect((engine as any).pendingMessages.size).toBe(0);
    });
  });

  describe("5. formatWechatMessage", () => {
    it("should format text message correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 1, text_item: { text: "Hello world" } },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req123");
      
      expect(result).toContain("__WECHAT_REQ_req123__");
      expect(result).toContain("[WeChat; wxid_user1]");
      expect(result).toContain("Hello world");
    });

    it("should format image message correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { 
            type: 2, 
            image_item: { decryptedPath: "/path/to/image.jpg" } 
          },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req456");
      
      expect(result).toContain("[图片: /path/to/image.jpg]");
    });

    it("should format voice message correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { 
            type: 3, 
            voice_item: { decryptedPath: "/path/to/voice.silk" } 
          },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req789");
      
      expect(result).toContain("[语音: /path/to/voice.silk]");
    });

    it("should format file message correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { 
            type: 4, 
            file_item: { file_name: "document.pdf" } 
          },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req999");
      
      expect(result).toContain("[文件: document.pdf]");
    });

    it("should format video message correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 5 },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req111");
      
      expect(result).toContain("[视频]");
    });

    it("should format mixed content correctly", () => {
      const msg = {
        from_user_id: "wxid_user1",
        item_list: [
          { type: 1, text_item: { text: "Text content" } },
          { type: 2, image_item: { decryptedPath: "/img.jpg" } },
          { type: 3, voice_item: { decryptedPath: "/voice.silk" } },
        ],
      } as any;

      const result = engine.formatWechatMessage(msg, "req_mixed");
      
      expect(result).toContain("Text content");
      expect(result).toContain("[图片: /img.jpg]");
      expect(result).toContain("[语音: /voice.silk]");
    });
  });

  describe("6. sendTypingStatus", () => {
    it("should send typing=1 (start)", async () => {
      mockSendTyping.mockResolvedValueOnce(undefined);

      await engine.sendTypingStatus("user123", "ctx_token", 1);

      expect(mockSendTyping).toHaveBeenCalledWith({
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
        body: {
          ilink_user_id: "user123",
          typing_ticket: "ctx_token",
          status: 1,
        },
      });
    });

    it("should send typing=2 (cancel)", async () => {
      mockSendTyping.mockResolvedValueOnce(undefined);

      await engine.sendTypingStatus("user123", "ctx_token", 2);

      expect(mockSendTyping).toHaveBeenCalledWith({
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "test_token",
        body: {
          ilink_user_id: "user123",
          typing_ticket: "ctx_token",
          status: 2,
        },
      });
    });

    it("should not throw on error", async () => {
      mockSendTyping.mockRejectedValue(new Error("API error"));

      // 应该不抛出异常
      await expect(
        engine.sendTypingStatus("user123", "ctx_token", 1)
      ).resolves.toBeUndefined();
    });
  });

  describe("7. setCurrentRequest / getCurrentRequestId / getCurrentUserId", () => {
    it("should save and retrieve current request info", () => {
      engine.setCurrentRequest("req_abc", "user_xyz");

      expect(engine.getCurrentRequestId()).toBe("req_abc");
      expect(engine.getCurrentUserId()).toBe("user_xyz");
    });

    it("should clear request info when set to null", () => {
      engine.setCurrentRequest("req_abc", "user_xyz");
      engine.setCurrentRequest(null, null);

      expect(engine.getCurrentRequestId()).toBe(null);
      expect(engine.getCurrentUserId()).toBe(null);
    });
  });

  describe("8. UserContext management", () => {
    it("should get user contexts map", () => {
      const contexts = engine.getUserContexts();
      expect(contexts).toBeInstanceOf(Map);
    });
  });
});
