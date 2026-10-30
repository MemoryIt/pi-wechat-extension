# Task: CS-7 收敛 Channel facade 公共面（移除仅测试用/已死的转发方法）

base: dev
branch: refactor/cs-7-facade-narrowing
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 194 pass / 23 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误。
  数量：允许 pass/files 计数变化（含下降）；「≥ 基线」不作为通过条件。
  覆盖面：被断言的外部行为集合不得缩小。
  删除/修改用例必须逐条给出去向（迁移 / 被蕴含 / 失效），写入 result 的 test-changes ledger。
  断言强度：不得削弱（禁止 toBe→toBeTruthy、删 expect、放宽精确值）。
  新增：迁移的用例须保留原断言强度。
invariant: 除下方「移除的方法」外，正常路径行为不变；Channel 其余公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 背景与目标

经 cs-1～cs-6，`Channel` 仍保留若干**生产代码不再调用、仅测试使用或已彻底死掉**的纯转发方法，
它们只撑大 facade 公共面。本阶段把它们移除，并把这些行为迁移到对应的协作类测试上。

**精确调用面（cs-6 后实测）**：

| 方法 | src 生产调用 | 测试调用 | 处理 |
|---|---|---|---|
| `getTerminalProcessing()` | 0 | 无（bridge 测试用的是 fake，非真 Channel） | **删除**，无测试改动 |
| `sendText(text)` | 0（cs-3 后唯一调用方已删） | 无（无人直接调 `channel.sendText`） | **删除**，无测试改动 |
| `getTypingTicket()` | 0 | `channel.test.ts` D16（3 例） | **删除**，用例迁移到 `TypingController` |
| `sendTypingStatus(status)` | 0 | `channel.test.ts` D16 | **删除**，用例迁移 |
| `getCurrentRequestId()` | 0 | `integration/channel-flow.test.ts`（3 处断言） | **删除**，断言改经 appendEntry/queue 观察 |

> 保留 `handleMessage` / `triggerAi`（虽生产路径已改经 InboundHandler/router，但属于 Channel 的
> 合理编排入口且被测试广泛使用），本阶段不动，避免过度重构。

## scope

prod（修改）：
- `src/channel/channel.ts`：删除公共方法 `getTerminalProcessing`、`getTypingTicket`、
  `sendTypingStatus`、`getCurrentRequestId`、`sendText`。删除后若某 import（如 `TypingController` 仅剩
  字段类型用途）仍被其它成员/字段引用则保留；确认无 `noUnusedLocals` 类问题。

tests（新增/修改）：
- 新增 `tests/channel/typing.test.ts`：把 D16 的 3 个用例迁移为**直接单测 `TypingController`**
  （`src/channel/typing.ts`），注入 fake `outbound` 与 `getContextToken`：
  - contextToken 变化 → 重新获取 ticket（原 D16-1）。
  - ticket TTL 60s 内命中、过期后重新获取（原 D16-2，沿用 `Date.now` 覆盖手法）。
  - `sendStatus` 报错含 `"ticket"` → 清缓存并重新获取（原 D16-3）。
  断言强度不低于原用例（精确 `toBe`/`toHaveBeenCalledTimes`）。
- `tests/channel/channel.test.ts`：删除上述 3 个 D16 用例（去向：**迁移** → `tests/channel/typing.test.ts`）；
  **保留 D16b**（`startTyping`/`stopTyping` 仍在，未删除）。
- `tests/integration/channel-flow.test.ts`：把 3 处 `channel.getCurrentRequestId()` 断言改为
  「从 `appendEntry[0][1].requestId` 捕获」+「经既有 `(channel as ...).router.queue` cast 观察当前 requestId」，
  保持原断言强度（相等 / 非空 / 排空后为 null）。

## 行为契约

- 移除的 5 个方法均为纯转发/无生产依赖；移除后 `Channel` 其余公共方法签名与行为不变。
- 迁移到 `TypingController` 的用例必须精确覆盖原 3 条 D16 语义（cache 绑定 contextToken、TTL、ticket 错误清缓存）。
- 集成测试对 requestId 的观察语义不变（本轮 requestId 一致、当前 turn 非空、onAiDone 后清空）。

## test-plan

- `tests/channel/typing.test.ts`（新增）：3 例（见上）。
- `tests/channel/channel.test.ts`：D16 3 例迁移删除；D16b 保留。
- `tests/integration/channel-flow.test.ts`：getCurrentRequestId 断言改写。
- 其余用例零改动。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] `rg "getTerminalProcessing|getTypingTicket|sendTypingStatus|getCurrentRequestId|sendText" src/channel/channel.ts` 无命中（5 个方法已删）
- [ ] 新增 `tests/channel/typing.test.ts`，直接测 `TypingController`，覆盖原 D16 三条语义
- [ ] `channel.test.ts` 的 D16 三例已迁移删除、D16b 保留；集成测试 requestId 观察语义不变
- [ ] `Channel` 其余公共 API / 窄接口契约不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/channel.ts`、`tests/channel/**`、`tests/integration/**`
- [ ] result 的 test-changes ledger 完整（删除的 D16 三例标「迁移」），无削弱断言
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、其它 `src/channel/*.ts`
- 不得删除/修改 `tests/setup/bridge-harness.ts` 的 fake `getTerminalProcessing`（它是 bridge 测试的观察 helper，与真 Channel 无关）
- 不得删除 `handleMessage` / `triggerAi` / `setTerminalProcessing` / `startTyping` / `stopTyping` / `isRequestProcessed` / `markRequestProcessed`
- 不得新增依赖；不得 push；不得改 `dev`
- 不得削弱断言

## report

完成后写 `/tmp/pi-tasks/cs-7.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-7`
