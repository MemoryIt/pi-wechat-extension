# Task: CS-1 turn 编排单一化（MessageRouter 成为唯一 turn 编排入口）

base: dev
branch: refactor/cs-1-turn-orchestration
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 171 pass / 20 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误。
  数量：允许 pass/files 计数变化（含下降）；「≥ 基线」不作为通过条件。
  覆盖面：被断言的外部行为集合不得缩小。
  删除/修改用例必须逐条给出去向（迁移 / 被蕴含 / 失效），写入 result 的 test-changes ledger。
  断言强度：不得削弱（禁止 toBe→toBeTruthy、删 expect、放宽精确值）。
  新增：本阶段新增的公共行为必须有用例覆盖。
invariant: 正常路径行为不变；Channel 公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 现象（问题）

turn 编排分裂在两处，`TurnQueue` 的忙闲 / 当前 requestId / 排空状态迁移散落在两个类：

1. `src/channel/channel.ts`
   - `private readonly queue = new TurnQueue<...>()`（Channel 持有队列）
   - `triggerAi()`：`queue.isBusy() || state.isTerminalMessageProcessing` → `queue.enqueue()`，否则 `router.execute()`
   - `onAiDone()`：`queue.setBusy(false)` + `setCurrentRequestId(null)` + `router.drain()`
   - `isRequestProcessed/markRequestProcessed/getCurrentRequestId` 直接访问 `queue`
2. `src/channel/router.ts`
   - `execute()`：文本分支 `setCurrentRequestId + setBusy(true)`；错误分支 `setBusy(false)+setCurrentRequestId(null)+drain()`；
     媒体分支 `markRequestProcessed + drain()`
   - `drain()`：空队列 `setBusy(false)`；否则出队 `execute()`

`queue` 经 `RouterDeps.queue` 注入 router，于是**同一个队列的迁移逻辑被两个类分别改写**。

## goal

让 `MessageRouter` **拥有** `TurnQueue` 并成为 **turn 编排的唯一入口**：

- 新增 `dispatch(msg, requestId, opts)`：收编现 `Channel.triggerAi` 的「忙/终端 → 入队，否则执行」。
- 新增 `onTurnDone()`：收编现 `Channel.onAiDone` 的「释放忙闲 + 排空」。
- `Channel` 不再持有 `TurnQueue` 字段；`triggerAi/onAiDone/isRequestProcessed/markRequestProcessed/getCurrentRequestId`
  改为委托 `router`（**公共方法签名与语义保持不变**）。
- `execute/drain` 可保留（供内部与既有单测），但队列状态迁移集中由 router 负责。

## scope

prod（修改）：
- `src/channel/router.ts`
  - `RouterDeps.queue` 改为**可选**（`queue?: TurnQueue<...>`），缺省在 router 内创建；router 暴露 `readonly queue`（供 Channel facade 委托与测试观察）。
  - `RouterDeps` 新增 `isTerminalProcessing(): boolean`（替代 Channel 对 `state.isTerminalMessageProcessing` 的直接读取）。
  - 新增 `dispatch(msg, requestId, opts): Promise<void>` 与 `onTurnDone(): void`。
- `src/channel/channel.ts`
  - 删除 `private readonly queue` 字段与相关直接引用。
  - 构造 router 时注入 `queue`（或交由 router 自建）与 `isTerminalProcessing`。
  - `triggerAi` → `await this.router.dispatch(...)`；`onAiDone` → `this.router.onTurnDone()`；
    `getCurrentRequestId/isRequestProcessed/markRequestProcessed` → 委托 router。

tests（新增/修改）：
- `tests/channel/router.test.ts`：harness 补 `isTerminalProcessing`；新增 `dispatch` / `onTurnDone` 用例。
- `tests/channel/channel.test.ts`：仅在构造/断言受影响处同步（**行为断言不得削弱**）。
- `tests/integration/channel-flow.test.ts`：如 `getCurrentRequestId` 等访问路径受影响则同步。

## 目标 API（方法名可微调，语义必须一致）

```ts
interface RouterDeps {
  queue?: TurnQueue<{ msg: WeixinMessage; requestId: string }>; // 缺省内部创建；保留注入便于测试
  mediaStore: MediaStore;
  mediaQueue: SerialTaskQueue;
  sender: MessageSender;
  getHost(): PiHost | null;
  getOpts(): RouterTurnOptions | null;
  isTerminalProcessing(): boolean;   // 新增
  logger: PluginLogger;
}

class MessageRouter {
  readonly queue: TurnQueue<{ msg: WeixinMessage; requestId: string }>;
  async dispatch(msg, requestId, opts): Promise<void>; // = 原 Channel.triggerAi
  onTurnDone(): void;                                  // = 原 Channel.onAiDone
  // execute / drain 保留
}
```

## 行为契约（必须保持）

- **文本 turn**：`appendEntry("wechat_meta", { requestId })` + `sendUserMessage(content, { deliverAs: "followUp" })`；
  成功后保持 `busy=true` / `currentRequestId=requestId` 等待 `onTurnDone`（D1）。
- **host 缺失 / `sendUserMessage` 同步抛错**：不冒泡，释放忙闲（`busy=false`、`currentRequestId=null`），
  `markRequestProcessed`，若有排队则排空。
- **纯媒体消息**：立即 ack（失败仅记日志、不阻断，F6）→ 入后台串行队列 → `markRequestProcessed` →
  不占忙闲 → 若有排队则排空。
- **dispatch 门控**：`queue.isBusy() || isTerminalProcessing()` 为真 → `enqueue`；否则 `execute`。
- **drain**：延迟 20ms；空队列 → 释放忙闲；否则出队执行；`execute` rejection 被捕获并释放状态（D1）。
- **D2**：`markRequestProcessed` 仍只在发送成功后由 `ReplyService` 调用（本阶段不改 ReplyService）。
- **D13**：requestId 生成仍在 Channel（`generateRequestId`），本阶段不迁移。
- `Channel` 公共方法签名与对外行为不变（bridge/application/tool 的窄接口契约不破坏）。

## test-plan

- `tests/channel/router.test.ts`（新增/修改）：
  - `dispatch`：空闲 → 调用 `execute`（宿主收到消息）；忙 → 入队不执行；终端处理中 → 入队不执行。
  - `onTurnDone`：清 `busy`/`currentRequestId`；有排队 → 排空（队首被执行）。
  - 既有 `execute` / `drain` / 媒体 / F6 用例保持通过（harness 补 `isTerminalProcessing`）。
- `tests/channel/channel.test.ts`：确认 `triggerAi/onAiDone` 委托后行为不变（若原有用例直接触碰队列，改为经公共方法断言）。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] `src/channel/channel.ts` 不再声明 `TurnQueue` 字段；`triggerAi/onAiDone` 委托 router
- [ ] `MessageRouter` 提供 `dispatch` / `onTurnDone`，且是队列状态迁移的唯一改写者
- [ ] 文本 / 媒体 / 错误 / 排空四条路径行为与契约一致；D1/F6 用例仍通过
- [ ] `Channel` 公共 API 与窄接口契约不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{channel,router}.ts`、`tests/channel/**`、`tests/integration/**`
- [ ] result 的 test-changes ledger 完整，无削弱断言
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言；不得以「简化」为由删除无去向的测试

## report

完成后写 `/tmp/pi-tasks/cs-1.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-1`
