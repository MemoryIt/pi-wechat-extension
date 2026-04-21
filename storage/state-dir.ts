/**
 * storage/state-dir.ts
 * 
 * 解析状态目录路径
 */

import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * 获取插件状态目录
 * 路径: {agentDir}/wechat/
 */
export function resolveStateDir(): string {
  return join(getAgentDir(), "wechat");
}
