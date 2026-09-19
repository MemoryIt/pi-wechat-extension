/**
 * tests/setup/mocks.ts
 *
 * 测试期的模块 mock 基础设施。
 *
 * 关键约定：
 * - 必须在「本进程第一次 import 任何被测源码」之前调用 installBaseMocks()。
 * - 由于 ESM 静态 import 会被提升，测试文件里应：
 *     import { installBaseMocks } from "../setup/mocks";
 *     installBaseMocks();
 *     const mod = await import("../../config.js");   // 动态 import
 *
 * 说明：这些 mock 只在测试运行时生效，不会读写仓库里底层模块的实现，也不修改生产代码。
 */
import { mock } from "bun:test";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** 仓库根目录（tests/setup -> 上两级）。 */
export const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/** 把相对仓库根的路径转成绝对路径，供 mock.module 精确匹配。 */
export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/**
 * 被测代码通过 @mariozechner/pi-coding-agent 的 getAgentDir() 决定存储位置。
 * 这里固定成一个临时目录，整个测试进程共用（模块级路径常量在 import 时求值）。
 */
export const agentDir = {
  value: mkdtempSync(path.join(tmpdir(), "pi-wechat-tests-")),
};

/** 清空并重建 agent 目录下的 wechat 子目录，实现用例间隔离。 */
export function resetAgentDir(): void {
  const dir = path.join(agentDir.value, "wechat");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** 快捷路径。 */
export function wechatDataDir(): string {
  return path.join(agentDir.value, "wechat");
}

let installed = false;

/**
 * 安装所有「核心文件会间接依赖」的基础 mock。
 * 覆盖：pi SDK（getAgentDir）、typebox（schema 构造）、util/logger。
 */
export function installBaseMocks(): void {
  if (installed) return;
  installed = true;

  // config.ts / storage/state.ts 依赖 getAgentDir()。
  mock.module("@mariozechner/pi-coding-agent", () => ({
    getAgentDir: () => agentDir.value,
    CONFIG_DIR_NAME: ".pi",
  }));

  // index.ts 只用 Type.Object / Type.String / Type.Optional 构造工具 schema。
  mock.module("@sinclair/typebox", () => ({
    Type: {
      Object: (properties: unknown) => ({ type: "object", properties }),
      String: (options?: unknown) => ({ type: "string", ...(options ?? {}) }),
      Optional: (schema: unknown) => schema,
    },
  }));

  // storage/state.ts import 了 ../util/logger.js。
  mock.module(repoPath("util", "logger.js"), () => ({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  }));
}
