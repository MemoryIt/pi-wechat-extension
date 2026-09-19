/**
 * tests/unit/config.test.ts
 *
 * 覆盖缺陷 D8：配置优先级 bug 与 DEFAULT_CONFIG 的 prefix 字段问题。
 *
 * 当前「证伪」用例断言旧行为（应当为绿，证明缺陷存在）；
 * 「目标」用例用 test.failing 断言修复后的正确行为（修复后会翻红，提示晋升）。
 */
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBaseMocks, agentDir, resetAgentDir } from "../setup/mocks";

installBaseMocks();

const config = await import("../../config.js");

const CONFIG_FILE = join(agentDir.value, "wechat", "config.json");

function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(agentDir.value, "wechat"), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(obj), "utf-8");
}

beforeEach(() => {
  resetAgentDir();
  delete process.env.WECHAT_DEBUG;
  delete process.env.WECHAT_MEDIA_PATH;
  config.clearConfigCache();
});

// ---------------------------------------------------------------------------
// D8-a：WECHAT_DEBUG=false 无法覆盖 config.json 的 debug:true
// ---------------------------------------------------------------------------

test("D8-a 目标：WECHAT_DEBUG=false 应覆盖 config.json 的 debug:true", () => {
  writeConfig({ debug: true });
  process.env.WECHAT_DEBUG = "false";
  config.clearConfigCache();

  expect(config.isDebugEnabled()).toBe(false);
});

// ---------------------------------------------------------------------------
// D8-b：只设置 WECHAT_MEDIA_PATH 会把 debug 强制变成 false
// ---------------------------------------------------------------------------

test("D8-b 目标：只设置 WECHAT_MEDIA_PATH 不应影响 config.json 的 debug", () => {
  writeConfig({ debug: true });
  process.env.WECHAT_MEDIA_PATH = "/tmp/pi-wechat-media";
  config.clearConfigCache();

  expect(config.getMediaStoragePath()).toBe("/tmp/pi-wechat-media");
  expect(config.isDebugEnabled()).toBe(true);
});

// ---------------------------------------------------------------------------
// 基线：无环境变量时 config.json 生效；WECHAT_DEBUG=true 生效
// ---------------------------------------------------------------------------

test("基线：无环境变量时读取 config.json", () => {
  writeConfig({ debug: true, mediaStoragePath: "/custom/media" });
  config.clearConfigCache();

  expect(config.isDebugEnabled()).toBe(true);
  expect(config.getMediaStoragePath()).toBe("/custom/media");
});

test("基线：WECHAT_DEBUG=true 可开启 debug", () => {
  writeConfig({ debug: false });
  process.env.WECHAT_DEBUG = "true";
  config.clearConfigCache();

  expect(config.isDebugEnabled()).toBe(true);
});

// ---------------------------------------------------------------------------
// D8-c：DEFAULT_CONFIG 含接口未声明的 prefix 字段
// ---------------------------------------------------------------------------

test("D8-c 目标：DEFAULT_CONFIG 不应包含 prefix 字段", () => {
  const defaultConfig = (config as unknown as { DEFAULT_CONFIG: Record<string, unknown> }).DEFAULT_CONFIG;
  expect(defaultConfig.prefix).toBeUndefined();
});
