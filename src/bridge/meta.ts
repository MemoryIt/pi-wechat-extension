/**
 * meta.ts - 模型 / 分支元信息
 *
 * 从 index.ts 拆出：git 分支缓存（实例状态 + refresh/getter）与
 * buildMetaInfo 的增量成本累计。
 *
 * 状态收拢在 `MetaBuilder` 实例上，由组合根在 `(pi) => {}` 内创建；
 * 同一次 `createExtension()(pi)` 的多次事件共享同一实例，
 * 不同组合根调用 / 测试实例互不污染。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBranch } from "./turn.js";

export class MetaBuilder {
  private cachedGitBranch: string | null = null;

  /**
   * buildMetaInfo 的增量成本累计：记录已处理的 entry id + 运行总量，
   * 使每轮只需处理新增分支（有界），而不是每轮全量扫描整个 branch。
   */
  private readonly costAccumulator = {
    processedIds: new Set<string>(),
    total: 0,
    lastIndex: 0,
    lastId: null as string | null,
  };

  /** 读取当前缓存的分支名（供 buildMetaInfo 使用）。 */
  getCachedGitBranch(): string | null {
    return this.cachedGitBranch;
  }

  /** 通过 pi.exec 读取当前 git 分支并更新实例缓存（session_start 调用）。 */
  async refreshGitBranch(pi: ExtensionAPI): Promise<void> {
    this.cachedGitBranch = await readGitBranch(pi);
  }

  buildMetaInfo(ctx: ExtensionContext): string {
    const lines: string[] = [];
    const cwd = ctx.cwd;
    const branchStr = this.cachedGitBranch ? ` (${this.cachedGitBranch})` : "";
    lines.push(`${cwd}${branchStr}`);

    const statsParts: string[] = [];

    const contextUsage = ctx.getContextUsage?.();
    if (contextUsage) {
      const { tokens, contextWindow, percent } = contextUsage;
      const percentStr = percent !== null ? `${percent.toFixed(1)}%` : "?%";
      const limitStr = `${(contextWindow / 1000).toFixed(0)}k`;
      statsParts.push(`${percentStr}/${limitStr}`);
    }

    const totalCost = this.accumulateCost(ctx);
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
  accumulateCost(ctx: ExtensionContext): number {
    const branch = getBranch(ctx);
    const accumulator = this.costAccumulator;

    let start = 0;
    if (
      accumulator.lastId !== null &&
      accumulator.lastIndex > 0 &&
      accumulator.lastIndex <= branch.length
    ) {
      const anchor = branch[accumulator.lastIndex - 1];
      if (anchor && anchor.id === accumulator.lastId) {
        start = accumulator.lastIndex;
      }
    }

    for (let i = start; i < branch.length; i++) {
      const entry = branch[i];
      const id = entry.id;
      if (id && accumulator.processedIds.has(id)) continue;

      if (entry.type === "message" && entry.message?.role === "assistant") {
        accumulator.total += entry.message.usage?.cost?.total ?? 0;
      }
      if (id) accumulator.processedIds.add(id);
    }

    accumulator.lastIndex = branch.length;
    accumulator.lastId = branch.length > 0 ? branch[branch.length - 1].id ?? null : null;

    return accumulator.total;
  }
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
