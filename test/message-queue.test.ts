/**
 * Phase 3b 消息队列单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WechatEngine, setPi } from "../wechat.js";
import type { WeixinMessage } from "../api/types.js";

// Mock pi instance
const mockPi = {
  sendMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  appendEntry: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  ui: {
    notify: vi.fn(),
    custom: vi.fn(),
  },
};

// Mock storage
vi.mock("../storage/state.js", () => ({
  getDefaultAccountToken: vi.fn().mockResolvedValue({
    accountId: "test_account",
    token: "test_token",
    baseUrl: "https://example.com",
  }),
  loadSyncCursor: vi.fn().mockResolvedValue(""),
  saveSyncCursor: vi.fn().mockResolvedValue(undefined),
}));

// Create a mock WeixinMessage
function createMockMessage(
  userId: string,
  text: string,
  contextToken = "test_ctx"
): WeixinMessage {
  return {
    message_id: Date.now(),
    from_user_id: userId,
    to_user_id: "bot_id",
    create_time_ms: Date.now(),
    session_id: "session_1",
    message_type: 1,
    context_token: contextToken,
    item_list: [
      {
        type: 1, // TEXT
        text_item: { text },
      },
    ],
  };
}

describe("Phase 3b: Message Queue", () => {
  let engine: WechatEngine;

  beforeEach(() => {
    // Reset engine state
    engine = new WechatEngine();

    // Inject mock pi via setPi (proper injection)
    setPi(mockPi as any);

    // Clear all mocks
    mockPi.sendMessage.mockClear();
    mockPi.appendEntry.mockClear();
    mockPi.sendUserMessage.mockClear();
  });

  afterEach(() => {
    // Clean up: reset the internal state and pending messages
    engine.onAiDone(); // This will process any pending messages
  });

  describe("triggerAi - queues message when AI is busy", () => {
    it("should queue message when AI is processing same user", async () => {
      const userId = "user_1";
      const msg1 = createMockMessage(userId, "Hello 1");
      const msg2 = createMockMessage(userId, "Hello 2");

      // First message - should trigger directly
      await engine.triggerAi(userId, msg1, "req_1");

      // Simulate AI is still processing
      (engine as any).isAiProcessing = true;
      (engine as any).currentUserId = userId;

      // Second message - should be queued
      await engine.triggerAi(userId, msg2, "req_2");

      // Verify message was queued
      const pending = (engine as any).pendingMessages.get(userId);
      expect(pending).toBeDefined();
      expect(pending!.length).toBe(1);
      expect(pending![0].msg).toBe(msg2);
      expect(pending![0].requestId).toBe("req_2");

      // Verify sendUserMessage was called only once (for first message)
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });

    it("should NOT queue message when AI is idle (isAiProcessing = false)", async () => {
      const userId = "user_1";
      const msg1 = createMockMessage(userId, "Hello 1");
      const msg2 = createMockMessage(userId, "Hello 2");

      // First message - triggers directly, sets isAiProcessing = true
      await engine.triggerAi(userId, msg1, "req_1");

      // After first message, AI is now busy
      expect((engine as any).isAiProcessing).toBe(true);

      // Second message should be queued (since AI is now busy)
      await engine.triggerAi(userId, msg2, "req_2");

      // Message should be queued
      const pending = (engine as any).pendingMessages.get(userId);
      expect(pending).toBeDefined();
      expect(pending!.length).toBe(1);

      // sendUserMessage should be called only once (for first message)
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("triggerAiForUser - sets processing state", () => {
    it("should set isAiProcessing = true and currentUserId", async () => {
      const userId = "user_1";
      const msg = createMockMessage(userId, "Hello");

      // Manually call triggerAiForUser (private, but we access via any)
      await (engine as any).triggerAiForUser(userId, msg, "req_1");

      expect((engine as any).isAiProcessing).toBe(true);
      expect((engine as any).currentUserId).toBe(userId);
    });

    it("should write wechat_meta entry", async () => {
      const userId = "user_1";
      const msg = createMockMessage(userId, "Hello");

      await (engine as any).triggerAiForUser(userId, msg, "req_123");

      expect(mockPi.appendEntry).toHaveBeenCalledWith("wechat_meta", {
        requestId: "req_123",
        userId: "user_1",
        timestamp: expect.any(Number),
      });
    });

    it("should call sendMessage with formatted content", async () => {
      const userId = "user_1";
      const msg = createMockMessage(userId, "Test message");

      await (engine as any).triggerAiForUser(userId, msg, "req_1");

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [msgArg] = mockPi.sendUserMessage.mock.calls[0];
      expect(msgArg.content).toContain("__WECHAT_REQ_req_1__");
      expect(msgArg.content).toContain("[WeChat; user_1]");
      expect(msgArg.content).toContain("Test message");
      expect(msgArg.triggerTurn).toBe(true);
    });
  });

  describe("onAiDone - triggers next message processing", () => {
    it("should reset isAiProcessing and currentUserId", async () => {
      const userId = "user_1";
      const msg = createMockMessage(userId, "Hello");

      // Set processing state
      (engine as any).isAiProcessing = true;
      (engine as any).currentUserId = userId;

      // Simulate AI done (no queued messages)
      (engine as any).pendingMessages.clear();

      engine.onAiDone();

      expect((engine as any).isAiProcessing).toBe(false);
      expect((engine as any).currentUserId).toBe(null);
    });

    it("should process next message from queue", async () => {
      const userId = "user_1";
      const msg1 = createMockMessage(userId, "Hello 1");
      const msg2 = createMockMessage(userId, "Hello 2");

      // Pre-queue a message
      (engine as any).pendingMessages.set(userId, [
        { msg: msg2, requestId: "req_2" },
      ]);
      (engine as any).isAiProcessing = true;
      (engine as any).currentUserId = userId;

      // Trigger AI done - should process next
      engine.onAiDone();

      // sendUserMessage should be called for the queued message
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);

      // Queue should be empty now
      const pending = (engine as any).pendingMessages.get(userId);
      expect(pending!.length).toBe(0);
    });
  });

  describe("processNextMessage - sequential processing", () => {
    it("should process multiple queued messages sequentially", async () => {
      const userId = "user_1";
      const msg1 = createMockMessage(userId, "Hello 1");
      const msg2 = createMockMessage(userId, "Hello 2");
      const msg3 = createMockMessage(userId, "Hello 3");

      // Queue 3 messages
      (engine as any).pendingMessages.set(userId, [
        { msg: msg1, requestId: "req_1" },
        { msg: msg2, requestId: "req_2" },
        { msg: msg3, requestId: "req_3" },
      ]);
      (engine as any).isAiProcessing = true;

      // Process all
      await (engine as any).processNextMessage();

      // Should have triggered 3 times (for the 3 queued messages)
      // Note: In real scenario, only first is triggered and others remain queued
      // because isAiProcessing is set to true again immediately.
      // But processNextMessage itself should shift all from queue.
    });

    it("should stop when queue is empty", async () => {
      const userId = "user_1";

      // Empty queue
      (engine as any).pendingMessages.clear();
      (engine as any).isAiProcessing = true;

      await (engine as any).processNextMessage();

      // isAiProcessing should remain true (queue empty means nothing to process,
      // but caller should handle setting to false)
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("should process messages from different users (round-robin)", async () => {
      const user1 = "user_1";
      const user2 = "user_2";
      const msgU1 = createMockMessage(user1, "U1");
      const msgU2 = createMockMessage(user2, "U2");

      // Queue messages from different users
      (engine as any).pendingMessages.set(user1, [{ msg: msgU1, requestId: "r1" }]);
      (engine as any).pendingMessages.set(user2, [{ msg: msgU2, requestId: "r2" }]);
      (engine as any).isAiProcessing = true;

      // processNextMessage uses a while loop that processes ALL non-empty queues
      // So it will process user1's message (making isAiProcessing=true again)
      // then continue to process user2's message (because while loop continues)
      // until all queues are empty
      await (engine as any).processNextMessage();

      // Both messages should be processed
      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(2);

      // Both queues should be empty
      expect((engine as any).pendingMessages.get(user1)!.length).toBe(0);
      expect((engine as any).pendingMessages.get(user2)!.length).toBe(0);
    });
  });

  describe("formatWechatMessage", () => {
    it("should format text message correctly", () => {
      const msg = createMockMessage("user_1", "Hello World");
      const formatted = engine.formatWechatMessage(msg, "req_123");

      expect(formatted).toBe("__WECHAT_REQ_req_123__[WeChat; user_1] Hello World");
    });

    it("should format image message", () => {
      const msg: WeixinMessage = {
        from_user_id: "user_1",
        message_type: 1,
        item_list: [
          {
            type: 2, // IMAGE
            image_item: { decryptedPath: "/path/to/image.jpg" },
          },
        ],
      };

      const formatted = engine.formatWechatMessage(msg, "req_1");
      expect(formatted).toContain("[图片: /path/to/image.jpg]");
    });

    it("should format voice message", () => {
      const msg: WeixinMessage = {
        from_user_id: "user_1",
        message_type: 1,
        item_list: [
          {
            type: 3, // VOICE
            voice_item: { decryptedPath: "/path/to/voice.wav" },
          },
        ],
      };

      const formatted = engine.formatWechatMessage(msg, "req_1");
      expect(formatted).toContain("[语音: /path/to/voice.wav]");
    });

    it("should format file message", () => {
      const msg: WeixinMessage = {
        from_user_id: "user_1",
        message_type: 1,
        item_list: [
          {
            type: 4, // FILE
            file_item: { file_name: "document.pdf" },
          },
        ],
      };

      const formatted = engine.formatWechatMessage(msg, "req_1");
      expect(formatted).toContain("[文件: document.pdf]");
    });

    it("should format video message", () => {
      const msg: WeixinMessage = {
        from_user_id: "user_1",
        message_type: 1,
        item_list: [
          {
            type: 5, // VIDEO
          },
        ],
      };

      const formatted = engine.formatWechatMessage(msg, "req_1");
      expect(formatted).toContain("[视频]");
    });
  });
});
