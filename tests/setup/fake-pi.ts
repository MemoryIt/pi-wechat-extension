/**
 * tests/setup/fake-pi.ts
 *
 * 探针型假 ExtensionAPI / ExtensionContext，用于在 L3 层测试 index.ts 的事件桥接，
 * 无需启动真正的 pi 运行时。
 */
import { mock } from "bun:test";

export type EventName =
  | "session_start"
  | "session_shutdown"
  | "before_agent_start"
  | "message_start"
  | "message_end"
  | "agent_end"
  | "agent_settled"
  | "input";

export interface FakePi {
  /** 传给 index.ts 默认导出的 pi 实例 */
  api: Record<string, unknown>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  tools: Map<string, { name: string; execute: (...args: unknown[]) => unknown }>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

export function createFakePi(): FakePi {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, { name: string; execute: (...args: unknown[]) => unknown }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerTool: (def: { name: string; execute: (...args: unknown[]) => unknown }) => {
      tools.set(def.name, def);
    },
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, opts);
    },
    getCommands: () => [],
    appendEntry: mock(() => {}),
    sendMessage: mock(() => {}),
    sendUserMessage: mock(() => {}),
    // index.ts 用 pi.exec 获取当前 git 分支，替代覆盖内置 footer。
    exec: mock(async () => ({ stdout: "main\n", stderr: "", code: 0, killed: false })),
  };

  return { api, handlers, tools, commands };
}

export function assistantMessage(text: string): { role: string; content: unknown } {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * 构造一个 sessionManager.getBranch() 返回的 assistant message entry。
 * 用于验证 agent_settled 阶段从分支中提取最终回复。
 */
export function assistantEntry(
  text: string,
  id = `assistant-${text}`,
): { type: string; id: string; message: { role: string; content: unknown } } {
  return { type: "message", id, message: assistantMessage(text) };
}

/** 构造一个 sessionManager.getBranch() 返回的 wechat_meta 自定义 entry。 */
export function wechatMetaEntry(requestId: string): {
  type: string;
  id: string;
  customType: string;
  data: { requestId: string };
} {
  return {
    type: "custom",
    id: `meta-${requestId}`,
    customType: "wechat_meta",
    data: { requestId },
  };
}

/** 构造一个普通的 message entry（用于终端消息场景）。 */
export function plainMessageEntry(): { type: string; id: string; message: { role: string; content: string } } {
  return {
    type: "message",
    id: "m-1",
    message: { role: "user", content: "hello from terminal" },
  };
}

export interface FakeCtx {
  cwd: string;
  ui: {
    notify: ReturnType<typeof mock>;
    setFooter: ReturnType<typeof mock>;
    setStatus: ReturnType<typeof mock>;
  };
  sessionManager: {
    getBranch: () => unknown[];
    getEntry: (id: string) => unknown;
    getLeafId: () => string | null;
  };
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number };
  model: { provider: string; id: string };
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
}

export function createFakeCtx(branch: unknown[] = []): FakeCtx {
  return {
    cwd: "/tmp/fake-project",
    ui: {
      notify: mock(() => {}),
      setFooter: mock(() => {}),
      setStatus: mock(() => {}),
    },
    sessionManager: {
      getBranch: () => branch,
      getEntry: () => undefined,
      getLeafId: () => (branch.length > 0 ? ((branch[branch.length - 1] as { id?: string }).id ?? null) : null),
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    model: { provider: "anthropic", id: "claude-test" },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
