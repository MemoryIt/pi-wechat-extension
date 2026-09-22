/**
 * config.ts
 * 微信插件配置管理
 * 
 * 配置路径: ~/.pi/agent/wechat/config.json
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "./paths.js";

// ============== 配置结构 ==============

export interface WechatPluginConfig {
  /** 是否启用调试日志 */
  debug?: boolean;
  /** 媒体文件存储路径，默认: {agentDir}/wechat/media */
  mediaStoragePath?: string;
}

export const DEFAULT_CONFIG: WechatPluginConfig = {
  debug: false,
};

// ============== 配置路径 ==============

const CONFIG_DIR = resolveStateDir();
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

  // 1. 读取 config.json（若存在）
  let userConfig: Partial<WechatPluginConfig> = {};
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      userConfig = JSON.parse(content) as Partial<WechatPluginConfig>;
    }
  } catch (err) {
    console.warn(`[Wechat] Failed to load config: ${err}`);
  }

  // 2. 基础优先级: config.json > 默认值
  const merged: WechatPluginConfig = { ...DEFAULT_CONFIG, ...userConfig };

  // 3. 环境变量按字段独立覆盖（不设置则保留 config.json / 默认值）
  const envDebug = process.env.WECHAT_DEBUG;
  if (envDebug !== undefined) {
    merged.debug = envDebug.toLowerCase() === "true";
  }
  if (process.env.WECHAT_MEDIA_PATH) {
    merged.mediaStoragePath = process.env.WECHAT_MEDIA_PATH;
  }

  cachedConfig = merged;
  return cachedConfig;
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
  return config.mediaStoragePath ?? join(resolveStateDir(), "media");
}
