# Task: RF-3 去模块级可变状态 + 组合根闭包接线

base: dev
branch: refactor/rf-3-instance-state
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 155 pass / 17 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公共 API、持久化格式、redact 规则、用户可见文案不得改变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## goal
清除 `src/bridge/` 的模块级可变状态，改为「组合根创建实例 + `pi.on` 闭包引用」：
- `bridge/turn.ts` 的模块级 `pendingWechatInputs` FIFO → `TurnResolver` 实例。
- `bridge/meta.ts` 的模块级 `cachedGitBranch` + `costAccumulator` → `MetaBuilder` 实例。
- `bridge/events.ts` / `bridge/tool-send-file.ts` 的模块级 `createLogger` → 构造注入。
- `index.ts` 在 `(pi) => {}` 内创建实例并注入 `registerBridge`。

保证：同一个 `createExtension()(pi)` 内的多次事件共享同一实例；不同 `createExtension()` 调用
（以及测试中的多个实例）**互不污染**。D4/D21 语义不得回退。

## scope
- prod（修改）：
  - `src/bridge/turn.ts`：新增 `TurnResolver` 实例类，持有 `pendingWechatInputs`；
    `pushPendingWechatInput` / `resetPendingWechatInputs` / `resolveTurnBeforeRun` 改为实例方法。
    纯函数（`getBranch` / `isAssistantMessage` / `extractLastReply` / `extractReplyText` /
    `resolvePendingWechatMeta` / `resolveActiveWechatMeta` / `resolveTurnFromBranch`）保持**模块导出不变**。
  - `src/bridge/meta.ts`：新增 `MetaBuilder` 实例类，持有 `cachedGitBranch` 与 `costAccumulator`；
    `refreshGitBranch` / `getCachedGitBranch` / `buildMetaInfo` / `accumulateCost` 改为实例方法；
    `readGitBranch(pi)` 保持模块函数。
  - `src/bridge/events.ts`：删除模块级 logger；`registerBridge(pi, deps)` 接收
    `{ channel, reply, session, turn, meta, logger }`；所有调用改用实例。
  - `src/bridge/tool-send-file.ts`：`createSendFileTool(channel, logger)`，删除模块级 logger。
  - `src/index.ts`：在 `(pi) => {}` 内 `new TurnResolver()` / `new MetaBuilder()`，把同一 `logger`
    连同实例一起注入 `createSendFileTool` 与 `registerBridge`。
- tests（修改/新增）：
  - `tests/bridge/turn.test.ts`：FIFO 相关用例改用 `new TurnResolver()` 实例。
  - `tests/bridge/meta.test.ts`：改用 `new MetaBuilder()` 实例。
  - `tests/bridge/state-isolation.test.ts`（新增）：证明实例间状态隔离。

## interface（建议；可微调，但保持上述方法语义）
```ts
// src/bridge/turn.ts
export class TurnResolver {
  pushPendingWechatInput(item: { requestId: string | null; text: string }): void;
  resetPendingWechatInputs(): void;
  resolveTurnBeforeRun(ctx: ExtensionContext, prompt?: string): WechatTurn;
}

// src/bridge/meta.ts
export class MetaBuilder {
  refreshGitBranch(pi: ExtensionAPI): Promise<void>;
  getCachedGitBranch(): string | null;
  buildMetaInfo(ctx: ExtensionContext): string;
  accumulateCost(ctx: ExtensionContext): number;
}
export async function readGitBranch(pi: ExtensionAPI): Promise<string | null>;

// src/bridge/events.ts
export interface BridgeDeps {
  channel: Channel;
  reply: ReplyService;
  session: SessionService;
  turn: TurnResolver;
  meta: MetaBuilder;
  logger: PluginLogger;
}
export function registerBridge(pi: ExtensionAPI, deps: BridgeDeps): void;
```

## 行为契约（必须保持）
- `input` 事件：`source === "extension"` 且 `turn.resolveTurnBeforeRun(ctx).fromWechat` 时
  `turn.pushPendingWechatInput({ requestId, text })`。
- `before_agent_start`：`turn.resolveTurnBeforeRun(ctx, event.prompt)`；非微信 turn 时
  `channel.setTerminalProcessing(true)` 并 debug 日志。
- `agent_settled`：DTO 的 `metaText` 用 `meta.buildMetaInfo(ctx)`（仅 `fromWechat=true`）。
- `session_start`：`await meta.refreshGitBranch(pi)`；其余与现状一致。
- `pendingWechatInputs` 的消费语义（命中即 splice 出队）不变。
- `costAccumulator` 的增量语义（按 entry id 去重、分支压缩回退全量去重）不变。

## 明确不改（out of scope，需在 result 中说明）
- `src/shared/config.ts` 的模块级 `cachedConfig`（配置缓存，有 `clearConfigCache()`）。
- `src/storage/state.ts` 的模块级 `mutationQueues`（按路径串行化的并发原语）。
  这两者属基础设施，非本轮目标；**不要动**。

## 依赖方向约束
- `src/bridge/**` 仍只依赖 `channel` / `application` 类型 / `ports` / `storage` / `shared`，
  不得新增对 vendor 或 `channel` 内部实现文件的 import。
- application 不得回退依赖 bridge。

## test-plan
- [ ] `tests/bridge/turn.test.ts`：`TurnResolver` 实例上验证 FIFO 兜底、命中消费、reset。
- [ ] `tests/bridge/meta.test.ts`：`MetaBuilder` 实例上验证元信息拼装与增量累计。
- [ ] `tests/bridge/state-isolation.test.ts`（新增）：
  - [ ] 两个 `TurnResolver`：向 A push，B 的 `resolveTurnBeforeRun` 不受影响。
  - [ ] 两个 `MetaBuilder`：在 A 上累计成本，B 上 `accumulateCost` 仍为 0（互不共享）。
- [ ] 既有 `tests/bridge/turn-state.test.ts`（D4/D21）与 `event-wiring.test.ts` 全绿。

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 155
- [ ] `rg "^let |^const .* = new (Map|Set)|^const .*: .*\[\] =" src/bridge src/application` 无命中
      （模块级可变状态已清零）
- [ ] `rg "^const logger = createLogger" src/` 无命中
- [ ] `TurnResolver` / `MetaBuilder` 为实例类；纯函数仍从 `turn.ts` / `meta.ts` 导出且未被破坏
- [ ] 新增 `tests/bridge/state-isolation.test.ts` 且通过
- [ ] 既有 D4/D21 测试通过，断言未被削弱
- [ ] `git diff dev...HEAD --stat` 仅限 `src/bridge/{turn,meta,events,tool-send-file}.ts`、
      `src/index.ts`、`tests/bridge/*`
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/shared/config.ts`、`src/storage/state.ts`、`src/channel/**`、`src/ports/**`、
  `src/adapters/**`、`src/application/**`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言（调整实例化方式属允许的最小改动）

## report
完成后写 `/tmp/pi-tasks/rf-3.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-3`
