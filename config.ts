/**
 * config.ts
 * 微信插件配置管理
 * 
 * 配置路径: ~/.pi/agent/wechat/config.json
 * 或通过环境变量 WECHAT_PREFIX 配置
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

// ============== 配置结构 ==============

export interface WechatPluginConfig {
  /** 消息前缀，默认为 [wechat] */
  prefix: string;
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 媒体文件存储路径，默认: {agentDir}/wechat/media */
  mediaStoragePath?: string;
}

export const DEFAULT_CONFIG: WechatPluginConfig = {
  prefix: "[wechat]",
  debug: false,
};

// ============== 配置路径 ==============

const CONFIG_DIR = join(getAgentDir(), "wechat");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

// ============== 配置加载 ==============

let cachedConfig: WechatPluginConfig | null = null;

/**
 * 加载插件配置
 * 优先级: 环境变量 > config.json > 默认值
 */
export function loadConfig(): WechatPluginConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  // 1. 优先使用环境变量
  const envPrefix = process.env.WECHAT_PREFIX;
  if (envPrefix !== undefined) {
    cachedConfig = {
      prefix: envPrefix,
      debug: process.env.WECHAT_DEBUG === "true",
      mediaStoragePath: process.env.WECHAT_MEDIA_PATH,
    };
    return cachedConfig;
  }

  // 2. 尝试加载 config.json
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      const userConfig = JSON.parse(content) as Partial<WechatPluginConfig>;
      cachedConfig = {
        ...DEFAULT_CONFIG,
        ...userConfig,
      };
      return cachedConfig;
    }
  } catch (err) {
    console.warn(`[Wechat] Failed to load config: ${err}`);
  }

  // 3. 使用默认值
  cachedConfig = { ...DEFAULT_CONFIG };
  return cachedConfig;
}

/**
 * 获取消息前缀
 */
export function getPrefix(): string {
  return loadConfig().prefix;
}

/**
 * 获取调试模式
 */
export function isDebugEnabled(): boolean {
  return loadConfig().debug ?? false;
}

/**
 * 清除配置缓存（用于测试或重载）
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * 获取媒体文件存储路径
 * 优先级: 环境变量 WECHAT_MEDIA_PATH > config.json > 默认值
 */
export function getMediaStoragePath(): string {
  const config = loadConfig();
  return config.mediaStoragePath ?? join(getAgentDir(), "wechat", "media");
}
