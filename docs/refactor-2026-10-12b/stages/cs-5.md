# Task: CS-5 入站处理器抽取 + 打破回调闭环（InboundHandler）

base: dev
branch: refactor/cs-5-inbound-handler
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 188 pass / 22 files / 0 fail
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

入站消息的“会话状态同步 + 派发”逻辑仍内联在 `Channel.handleMessage`：

- 生成 `requestId`（`Channel.generateRequestId` / `RequestIdGenerator`）。
- 若 `msg.context_token` 与 `state.contextToken` 不同：debug 日志 → 写 `state.contextToken` →
  `typing.invalidateTicket()` → 条件持久化 `storage.saveContextToken(...)`。
- 调 `this.triggerAi(...)` → `router.dispatch(...)`。

并且 `PollingLoopDeps.onMessage` 指向 `() => this.handleMessage(...)`，
即 **poller 的第二个构造期回调仍指回 Channel**（cs-4 已解除 `ensureSession` 那一半）。

## goal

把入站处理抽成独立协作类 `InboundHandler`，使两个 poller 回调都指向协作对象：

- 新增 `src/channel/inbound-handler.ts`，承载上述逻辑 + requestId 生成。
- `Channel` 构造 `InboundHandler`，`poller.onMessage` 指向 `inboundHandler.handle`。
- `Channel.handleMessage(msg, opts)` 保留为**公共委托**（`channel.test.ts` / 集成测试多处调用）。
- `Channel.triggerAi(msg, requestId, opts)` 保留为公共委托（`router.dispatch`；测试仍直接调用）。

## scope

prod（新增）：
- `src/channel/inbound-handler.ts`
  ```ts
  import type { WeixinMessage } from "../ports/types.js";
  import type { WechatApiOpts } from "../shared/types.js";
  import * as storage from "../storage/state.js";
  import type { ChannelState } from "./state.js";
  import type { RequestIdGenerator } from "./request-id.js";
  import type { PluginLogger } from "../shared/logger.js";

  /** 最小依赖（窄接口，便于单测注入）。 */
  export interface InboundTyping { invalidateTicket(): void; }
  export interface InboundDispatch {
    dispatch(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void>;
  }
  export interface InboundHandlerDeps {
    state: ChannelState;
    typing: InboundTyping;
    router: InboundDispatch;
    requestId: RequestIdGenerator;
    logger: PluginLogger;
  }
  export class InboundHandler {
    constructor(deps: InboundHandlerDeps);
    async handle(msg: WeixinMessage, opts: WechatApiOpts): Promise<void>;  // = 原 Channel.handleMessage 主体
  }
  export function createInboundHandler(deps: InboundHandlerDeps): InboundHandler;
  ```

prod（修改）：
- `src/channel/channel.ts`
  - 新增 `private readonly inboundHandler: InboundHandler;`，在构造函数中创建
    （依赖 `state` / `typing` / `router` / `requestId` / `logger`）。
  - `poller.onMessage` 改为 `(msg, opts) => this.inboundHandler.handle(msg, opts)`。
  - `handleMessage(msg, opts)` 改为委托 `return this.inboundHandler.handle(msg, opts)`。
  - **`requestId` 字段与 `generateRequestId()` 迁入 `InboundHandler`**：Channel 删除二者
    （requestId 生成不再属于编排器）。`triggerAi` 保留公共委托；`onAiDone` 不变。
  - 同步更新文件头注释（协作类列表加入 InboundHandler）。

tests（新增/修改）：
- 新增 `tests/channel/inbound-handler.test.ts`（直接单测 `InboundHandler`，注入 fake state/typing/router/requestId/logger）。
- `tests/channel/channel.test.ts`：处理 D13 用例（见 test-plan）；其余 `handleMessage`/`triggerAi` 用例经公共委托保持通过。

## 行为契约（必须逐字保持）

- 顺序：**先生成 `requestId`** → 判断 `msg.context_token` 是否非空且不等于 `state.contextToken` →
  若不同：`logger.debug("Updating contextToken from message")` → `state.contextToken = msg.context_token` →
  `typing.invalidateTicket()` → **仅当** `state.accountId && state.userId` 时
  `storage.saveContextToken(accountId, userId, { displayName: userId, contextToken: msg.context_token, lastMessageAt: Date.now() })`
  → 最后 `router.dispatch(msg, requestId, opts)`。
- `context_token` 缺失或与当前相同：不做任何 contextToken 副作用，仍 `dispatch`。
- requestId 格式/唯一性由 `RequestIdGenerator` 保证（本阶段不改变其实现）。
- `Channel.handleMessage` / `triggerAi` 对外签名与行为不变。

## test-plan

- 新增 `tests/channel/inbound-handler.test.ts`：
  - contextToken 变化 + accountId/userId 齐全 → state 更新、`invalidateTicket` 调用、
    `saveContextToken` 以精确参数调用、`dispatch` 收到生成的 requestId 与 opts。
  - contextToken 变化但 accountId/userId 缺失 → state 更新 + `invalidateTicket`，**不**调用 `saveContextToken`，仍 dispatch。
  - `context_token` 缺失 / 与当前相同 → 无更新、无 `invalidateTicket`、无 `saveContextToken`，仍 dispatch。
  - 顺序/请求 id：用 fake `requestId.next()` 固定返回值，断言 `dispatch(msg, "<id>", opts)`。
- `tests/channel/channel.test.ts`：
  - **D13 用例**（`同一毫秒内的 requestId 应保持唯一`，经 `(channel as AnyChannel).generateRequestId()`）
    在 `generateRequestId` 迁出后失效；其不变量（同毫秒唯一）已由 `tests/channel/request-id.test.ts`
    确定性覆盖 → 记为 **被蕴含（subsumed）** 并删除，ledger 说明去向。
    若选择迁移，则须迁移为对 `RequestIdGenerator`/`InboundHandler` 的直接断言且不更弱。
  - 其余 `handleMessage` / `triggerAi` 用例经公共委托保持通过。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] 新增 `src/channel/inbound-handler.ts`，导出 `InboundHandler`（及工厂），仅依赖 `ports/types`、`shared/types`、`storage/state`、`./state`、`./request-id`、`shared/logger`
- [ ] `Channel` 的 `poller.onMessage` 指向 `inboundHandler.handle`（`rg` 确认不再 `this.handleMessage`）
- [ ] `Channel.handleMessage` / `triggerAi` 为委托；签名不变；`Channel` 已无 `requestId` 字段与 `generateRequestId`
- [ ] 行为契约逐条一致（新用例覆盖）
- [ ] `Channel` 其余公共 API / 文案 / 持久化 / 端口签名不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{inbound-handler,channel}.ts`、`tests/channel/**`
- [ ] result 的 test-changes ledger 完整，无削弱断言
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、其它 `src/channel/*.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言（D13 的删除须按 test-policy 记为「被蕴含」并说明依据）

## report

完成后写 `/tmp/pi-tasks/cs-5.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-5`
