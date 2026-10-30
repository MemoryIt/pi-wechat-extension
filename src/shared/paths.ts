/**
 * paths.ts - 共享路径工具
 *
 * 统一解析插件状态目录，供 storage 与 config 复用。
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 插件状态目录：{agentDir}/wechat */
export function resolveStateDir(): string {
  return join(getAgentDir(), "wechat");
}
