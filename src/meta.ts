/**
 * meta.ts - 模型 / 分支元信息
 *
 * 从 index.ts 拆出：git 分支缓存（模块内状态 + refresh/getter）与
 * buildMetaInfo 的增量成本累计。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBranch } from "./turn.js";

// ============== 缓存 ==============

let cachedGitBranch: string | null = null;

/** 读取当前缓存的分支名（供 buildMetaInfo 使用）。 */
export function getCachedGitBranch(): string | null {
  return cachedGitBranch;
}

/** 通过 pi.exec 读取当前 git 分支并更新模块缓存（session_start 调用）。 */
export async function refreshCachedGitBranch(pi: ExtensionAPI): Promise<void> {
  cachedGitBranch = await readGitBranch(pi);
}

export async function readGitBranch(pi: ExtensionAPI): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["branch", "--show-current"]);
    const branch = (result?.stdout ?? "").trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * buildMetaInfo 的增量成本累计：记录已处理的 entry id + 运行总量，
 * 使每轮只需处理新增分支（有界），而不是每轮全量扫描整个 branch。
 */
const costAccumulator = {
  processedIds: new Set<string>(),
  total: 0,
  lastIndex: 0,
  lastId: null as string | null,
};

export function buildMetaInfo(ctx: ExtensionContext): string {
  const lines: string[] = [];
  const cwd = ctx.cwd;
  const branchStr = cachedGitBranch ? ` (${cachedGitBranch})` : "";
  lines.push(`${cwd}${branchStr}`);

  const statsParts: string[] = [];

  const contextUsage = ctx.getContextUsage?.();
  if (contextUsage) {
    const { tokens, contextWindow, percent } = contextUsage;
    const percentStr = percent !== null ? `${percent.toFixed(1)}%` : "?%";
    const limitStr = `${(contextWindow / 1000).toFixed(0)}k`;
    statsParts.push(`${percentStr}/${limitStr}`);
  }

  const totalCost = accumulateCost(ctx);
  if (totalCost > 0) {
    statsParts.push(`$${totalCost.toFixed(3)}`);
  }

  if (ctx.model) {
    statsParts.push(`(${ctx.model.provider}) ${ctx.model.id}`);
  }

  if (statsParts.length > 0) {
    lines.push(statsParts.join(" "));
  }

  return lines.join("\n");
}

/**
 * 增量累计分支中的 assistant 成本。
 * 记录已处理 entry id + 运行总量，并在分支连续增长时只处理新增部分；
 * 分支发生压缩 / 分叉时回退为按 id 去重的扫描，保证不重复累计。
 */
export function accumulateCost(ctx: ExtensionContext): number {
  const branch = getBranch(ctx);

  let start = 0;
  if (
    costAccumulator.lastId !== null &&
    costAccumulator.lastIndex > 0 &&
    costAccumulator.lastIndex <= branch.length
  ) {
    const anchor = branch[costAccumulator.lastIndex - 1];
    if (anchor && anchor.id === costAccumulator.lastId) {
      start = costAccumulator.lastIndex;
    }
  }

  for (let i = start; i < branch.length; i++) {
    const entry = branch[i];
    const id = entry.id;
    if (id && costAccumulator.processedIds.has(id)) continue;

    if (entry.type === "message" && entry.message?.role === "assistant") {
      costAccumulator.total += entry.message.usage?.cost?.total ?? 0;
    }
    if (id) costAccumulator.processedIds.add(id);
  }

  costAccumulator.lastIndex = branch.length;
  costAccumulator.lastId = branch.length > 0 ? branch[branch.length - 1].id ?? null : null;

  return costAccumulator.total;
}
