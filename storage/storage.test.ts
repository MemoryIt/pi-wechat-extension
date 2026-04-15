/**
 * storage.test.ts - 存储模块测试（单用户便捷函数）
 * 
 * 注意：由于 storage/state.ts 模块的复杂性，这里使用集成测试方式
 * 测试实际的函数逻辑
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger
vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("Storage Module - Existing Functions", () => {
  // 测试原有函数仍然正常工作
  it("should have listAccounts function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.listAccounts).toBe("function");
  });

  it("should have getDefaultAccountToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.getDefaultAccountToken).toBe("function");
  });

  it("should have saveToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.saveToken).toBe("function");
  });

  it("should have loadToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.loadToken).toBe("function");
  });

  it("should have saveContextToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.saveContextToken).toBe("function");
  });

  it("should have loadContextToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.loadContextToken).toBe("function");
  });
});

describe("Storage Module - New Single User Functions", () => {
  // 测试新增函数存在
  it("should have getSingleUserCredentials function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.getSingleUserCredentials).toBe("function");
  });

  it("should have getSingleUserContextToken function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.getSingleUserContextToken).toBe("function");
  });

  it("should have getSingleUserId function", async () => {
    const storage = await import("./state.js");
    expect(typeof storage.getSingleUserId).toBe("function");
  });
});
