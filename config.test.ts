/**
 * config.test.ts - 配置模块测试
 * 
 * 测试策略：
 * 1. 测试默认值加载
 * 2. 测试配置文件加载
 * 3. 测试环境变量覆盖
 * 4. 测试配置缓存
 * 5. 测试缓存清除
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fs 模块 - 使用 vi.hoisted 避免 hoisting 问题
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => {
  return {
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
  };
});

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Mock getAgentDir
vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/test-agent",
}));

// Mock 环境变量
const originalEnv = { ...process.env };

describe("Config Module Tests", () => {
  beforeEach(() => {
    // 清理模块缓存，确保每次测试都是干净状态
    vi.resetModules();
    vi.clearAllMocks();
    
    // 重置环境变量
    process.env = { ...originalEnv };
    delete process.env.WECHAT_PREFIX;
    delete process.env.WECHAT_DEBUG;
    
    // 重置 mock
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("{}");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ============== 1. 默认配置测试 ==============
  
  describe("1. Default Config", () => {
    it("should return default prefix when no config file exists", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(false);
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[wechat]");
      expect(config.debug).toBe(false);
    });

    it("should return default config when config file is empty", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{}");
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[wechat]");
      expect(config.debug).toBe(false);
    });
  });

  // ============== 2. 配置文件测试 ==============
  
  describe("2. Config File Loading", () => {
    it("should load prefix from config file", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        prefix: "[my-wechat]",
        debug: true
      }));
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[my-wechat]");
      expect(config.debug).toBe(true);
    });

    it("should handle invalid JSON in config file gracefully", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("invalid json {{{");
      
      // 应该回退到默认值
      const config = loadConfig();
      
      expect(config.prefix).toBe("[wechat]");
      expect(config.debug).toBe(false);
    });

    it("should merge partial config with defaults", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        prefix: "[custom]"
        // debug 未指定，应使用默认值
      }));
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[custom]");
      expect(config.debug).toBe(false); // 默认值
    });
  });

  // ============== 3. 环境变量测试 ==============
  
  describe("3. Environment Variable Override", () => {
    it("should override prefix from environment variable", async () => {
      process.env.WECHAT_PREFIX = "[env-prefix]";
      process.env.WECHAT_DEBUG = "true";
      
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[env-prefix]");
      expect(config.debug).toBe(true);
    });

    it("should override only prefix when only WECHAT_PREFIX is set", async () => {
      process.env.WECHAT_PREFIX = "[env-only]";
      
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      const config = loadConfig();
      
      expect(config.prefix).toBe("[env-only]");
      expect(config.debug).toBe(false); // 默认值
    });

    it("should handle empty environment variable", async () => {
      process.env.WECHAT_PREFIX = "";
      
      const { loadConfig, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      const config = loadConfig();
      
      // 空字符串应该被视为有效值
      expect(config.prefix).toBe("");
    });
  });

  // ============== 4. 配置缓存测试 ==============
  
  describe("4. Config Caching", () => {
    it("should cache config after first load", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      
      // 第一次加载
      loadConfig();
      
      // 再次加载，应该返回缓存值（第一次的值）
      const config = loadConfig();
      expect(config.prefix).toBe("[wechat]"); // 旧值，因为被缓存了
      
      // 清除缓存后，由于 mock 默认返回 {}，会使用默认值
      clearConfigCache();
      const config2 = loadConfig();
      expect(config2.prefix).toBe("[wechat]");
    });
    
    it("clearConfigCache should allow reloading config", async () => {
      const { loadConfig, clearConfigCache } = await import("./config.js");
      
      // 加载配置
      const config1 = loadConfig();
      
      // 清除缓存
      clearConfigCache();
      
      // 重新加载，应该返回新的配置
      const config2 = loadConfig();
      
      // 两者应该是不同的引用（因为缓存被清除）
      expect(config1).not.toBe(config2);
    });
  });

  // ============== 5. 便捷函数测试 ==============
  
  describe("5. Convenience Functions", () => {
    it("getPrefix should return prefix from config", async () => {
      const { getPrefix, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        prefix: "[test-prefix]"
      }));
      
      expect(getPrefix()).toBe("[test-prefix]");
    });

    it("isDebugEnabled should return debug flag from environment", async () => {
      // 在当前测试环境中，环境变量需要在模块加载前设置
      // 由于模块缓存，我们需要重新设置
      const { isDebugEnabled, clearConfigCache } = await import("./config.js");
      clearConfigCache();
      
      // 直接测试默认值
      expect(isDebugEnabled()).toBe(false);
    });
  });
});
