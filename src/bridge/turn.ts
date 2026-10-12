/**
 * turn.ts - 每轮 turn 身份解析（近纯函数）
 *
 * 从 index.ts 拆出：在事件发生时同步从 session 分支解析 `{ fromWechat, requestId }`，
 * 不保存跨轮的可变 turn 标记。`input` 事件注入的待处理 FIFO 也在此维护，
 * 通过 `pushPendingWechatInput()` / `resetPendingWechatInputs()` 暴露给 events.ts。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WechatTurn {
  fromWechat: boolean;
  requestId: string | null;
}

/** 统一的分支 entry 视图（fake / 真实 SessionEntry 的公共子集）。 */
export interface BranchEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  data?: { requestId?: string };
  message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } } };
}

/**
 * 由 `input` 事件（`pi.sendUserMessage` 注入）维护的待处理微信消息 FIFO。
 * 只用于在 `event.prompt` 兜底时识别来源，不保存跨轮的可变 turn 标记。
 *
 * 状态收拢在实例上，由组合根在 `(pi) => {}` 内创建；同一次 `createExtension()(pi)`
 * 的多次事件共享同一实例，不同组合根调用 / 测试实例互不污染。
 */
export class TurnResolver {
  private readonly pendingWechatInputs: Array<{ requestId: string | null; text: string }> = [];

  /** 入队一条注入的微信输入（供 events.ts 的 input 处理器使用）。 */
  pushPendingWechatInput(item: { requestId: string | null; text: string }): void {
    this.pendingWechatInputs.push(item);
  }

  /** 清空待处理队列（重置 / 测试用）。 */
  resetPendingWechatInputs(): void {
    this.pendingWechatInputs.length = 0;
  }

  /**
   * 事件发生时同步解析 turn 身份（pre-run）：优先用 session 中的 wechat_meta，
   * 找不到时用 event.prompt 与 input FIFO 兜底。
   */
  resolveTurnBeforeRun(ctx: ExtensionContext, prompt?: string): WechatTurn {
    const meta = resolvePendingWechatMeta(ctx);
    if (meta) return { fromWechat: true, requestId: meta.requestId };

    if (typeof prompt === "string") {
      const idx = this.pendingWechatInputs.findIndex((item) => item.text === prompt);
      if (idx >= 0) {
        const [item] = this.pendingWechatInputs.splice(idx, 1);
        return { fromWechat: true, requestId: item.requestId };
      }
    }

    return { fromWechat: false, requestId: null };
  }
}

/** 统一的分支 entry 视图读取。 */
export function getBranch(ctx: ExtensionContext): BranchEntry[] {
  return ctx.sessionManager.getBranch() as unknown as BranchEntry[];
}

export function isAssistantMessage(event: unknown): boolean {
  return (event as { message?: { role?: string } })?.message?.role === "assistant";
}

/**
 * pre-run（before_agent_start / input）阶段：当前 user 消息尚未写入分支，
 * 因此从叶子向前扫描，遇到 wechat_meta 即为微信 turn；
 * 先遇到 assistant 说明上一轮已结束，属终端 turn。
 */
export function resolvePendingWechatMeta(ctx: ExtensionContext): { requestId: string | null } | null {
  const branch = getBranch(ctx);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === "wechat_meta") {
      return { requestId: entry.data?.requestId ?? null };
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return null;
    }
  }
  return null;
}

export function resolveTurnFromBranch(ctx: ExtensionContext): WechatTurn {
  const meta = resolveActiveWechatMeta(ctx);
  return { fromWechat: meta !== null, requestId: meta?.requestId ?? null };
}

/**
 * 运行中 / 结束后：当前 user 消息已经在分支里，用它的 parentId 反向关联 wechat_meta。
 * 若还没有 user 消息（测试夹具 / 边界情况），退化为 pre-run 规则。
 */
export function resolveActiveWechatMeta(ctx: ExtensionContext): { requestId: string | null } | null {
  const branch = getBranch(ctx);

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];

    if (entry.type === "message" && entry.message?.role === "user") {
      const parentId = entry.parentId;
      if (parentId) {
        const parent = ctx.sessionManager.getEntry(parentId) as
          | { type?: string; customType?: string; data?: { requestId?: string } }
          | undefined;
        if (parent?.type === "custom" && parent.customType === "wechat_meta") {
          return { requestId: parent.data?.requestId ?? null };
        }
      }
      return null;
    }

    if (entry.type === "custom" && entry.customType === "wechat_meta") {
      return { requestId: entry.data?.requestId ?? null };
    }
  }

  return null;
}

/** 提取 branch 中最后一条有文本的 assistant 回复。 */
export function extractLastReply(ctx: ExtensionContext): string | null {
  const branch = getBranch(ctx);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const text = extractReplyText(entry.message);
      if (text) return text;
    }
  }
  return null;
}

export function extractReplyText(assistantMsg: unknown): string | null {
  const msg = assistantMsg as { content?: unknown };

  if (typeof msg.content === "string") {
    return msg.content.trim() || null;
  }
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const block of msg.content) {
      const blockObj = block as { type?: string; text?: string };
      if (blockObj.type === "text") {
        texts.push(blockObj.text ?? "");
      }
    }
    return texts.join("\n").trim() || null;
  }
  if (typeof msg.content === "object" && msg.content !== null) {
    const contentObj = msg.content as { text?: string };
    if (contentObj.text) {
      return contentObj.text.trim();
    }
  }
  return null;
}
