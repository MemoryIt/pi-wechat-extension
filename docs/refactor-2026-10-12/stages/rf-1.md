# Task: RF-1 抽出应用层 reply 决策（bridge/events 变薄）

base: dev
branch: refactor/rf-1-application-reply
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 129 pass / 15 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## goal
把 `agent_settled` 的「发送决策」从 `src/bridge/events.ts` 抽到新的 `src/application/`：
- 新增 `src/application/types.ts`（`SettledContext` DTO + `ReplyChannel` 窄接口）
- 新增 `src/application/reply.ts`（`ReplyService.handleSettled`）
- `src/bridge/events.ts` 只做「事件 → DTO → ReplyService」

本阶段**不改变任何对外行为与事件时序**；D1/D2/D5 语义必须保持。

## scope
- prod（新增）：
  - `src/application/types.ts`
  - `src/application/reply.ts`
- prod（修改）：
  - `src/bridge/events.ts`：`agent_settled` 构造 DTO 并调用 `reply.handleSettled`；
    删除本地 `handleWechatSettled`；`registerBridge(pi, channel, reply)` 增加 `reply` 参数
  - `src/index.ts`：`new ReplyService({ channel, logger })` 并传给 `registerBridge`
- tests（新增）：
  - `tests/application/reply.test.ts`

## interface（建议；可微调，但保持窄）
```ts
// src/application/types.ts
export interface SettledContext {
  fromWechat: boolean;
  requestId: string | null;
  replyText: string | null;
  metaText: string | null;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ReplyChannel {
  isRequestProcessed(id: string): boolean;
  stopTyping(): Promise<void>;
  sendReply(text: string, maxRetries?: number): Promise<void>;
  markRequestProcessed(id: string): void;
  setTerminalProcessing(value: boolean): void;
  onAiDone(): void;
}

// src/application/reply.ts
export class ReplyService {
  constructor(deps: { channel: ReplyChannel; logger: PluginLogger });
  handleSettled(ctx: SettledContext): Promise<void>;
}
```

## 行为契约（必须逐条保持）
- `fromWechat=false`：`setTerminalProcessing(false)`，随后 `onAiDone()`；**不发送**。
- `fromWechat=true` 且 `requestId` 为空 / 已被处理 / 无 `replyText`：**不发送**，最终 `onAiDone()`。
- 成功：`stopTyping()` → `sendReply(finalReply)` → 成功后 `markRequestProcessed(requestId)`。
- `finalReply = replyText + (metaText ? "\n\n" + metaText : "")`。
- 发送失败：**不得** `markRequestProcessed`；调用 `notify("微信回复失败: <msg>", "error")`。
- `handleSettled` **所有路径**都必须最终 `channel.onAiDone()`（用 `finally`）。
- 构造 DTO 时：`fromWechat=false` 不得调用 `extractLastReply` / `buildMetaInfo`。

## 依赖方向约束
- `src/application/**` 不得 import：
  `@earendil-works/pi-coding-agent`、`bridge/**`、vendor（`api/ auth/ cdn/ media/ messaging/ util/`）、
  `../channel/channel.js`。
- `src/application/reply.ts` 只依赖 `./types.js` 与 `../shared/logger.js`。

## test-plan
新增 `tests/application/reply.test.ts`（直接用 fake `ReplyChannel`，不经过 pi）：
- [ ] `fromWechat=false` → `setTerminalProcessing(false)` + `onAiDone`，无 send
- [ ] 成功路径顺序：`stopTyping` → `sendReply` → `markRequestProcessed` → `onAiDone`
- [ ] `sendReply` 抛错 → 不 mark、`notify(error)`、`onAiDone`
- [ ] 已处理 `requestId` → 不 send、`onAiDone`
- [ ] 无 `replyText` → 不 send、`onAiDone`
- [ ] `requestId=null` → 不 send、`onAiDone`
- [ ] `metaText` 拼接格式正确

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 129
- [ ] 新增 `src/application/types.ts`、`src/application/reply.ts`、`tests/application/reply.test.ts`
- [ ] `src/bridge/events.ts` 不再出现 `sendReply` / `markRequestProcessed` / `isRequestProcessed` 决策
- [ ] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
- [ ] D1/D2/D5 相关既有测试仍通过
- [ ] `git diff dev...HEAD --stat` 仅限上述文件
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/bridge/turn.ts`、`src/bridge/meta.ts`、`src/channel/**`、`src/ports/**`、`src/adapters/**`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言（如需调整构造方式，最小改动）

## report
完成后写 `/tmp/pi-tasks/rf-1.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-1`
