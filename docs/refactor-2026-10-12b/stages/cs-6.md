# Task: CS-6 channel 内部装配工厂（create-channel）

base: dev
branch: refactor/cs-6-channel-factory
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
  新增：本阶段新增的公共行为必须有用例覆盖（本阶段为内部装配，无用户可观察行为）。
invariant: 正常路径行为不变；Channel 公共 API（含构造签名 ChannelDeps）/ 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 现象（问题）

`Channel` 构造函数仍同时承担两件事：**装配**（`new` 出 8 个协作类并互相注入回调）与**持有/行为**。
构造函数约 70 行，回调里还内联引用了 `this.getCredentials()` / `this.getCurrentOpts()` 等
Channel 私有方法。cs-4/cs-5 已解除 poller 两个回调对 Channel 方法的依赖，现在可以自底向上装配。

## goal

把全部 `new` + 回调注入从 `Channel` 构造函数抽到内部工厂 `createChannelRuntime(deps)`：

- 新增 `src/channel/create-channel.ts`。
- `Channel` 构造函数改为「调用工厂 → 把结果赋给自身字段」；Channel 只保留真正用到的字段。
- **不改 `ChannelDeps` / `Channel` 公共 API**；`new Channel({ state, ports, logger })` 用法不变。

## scope

prod（新增）：
- `src/channel/create-channel.ts`
  ```ts
  import type { ChannelPorts, ChannelDeps } ...  // 复用 ChannelDeps（见下）
  export interface ChannelRuntime {
    state: ChannelState;
    logger: PluginLogger;
    credentialLoader: CredentialLoader;
    poller: PollingLoop;
    typing: TypingController;
    sender: MessageSender;
    router: MessageRouter;
    inboundHandler: InboundHandler;
  }
  export function createChannelRuntime(deps: ChannelDeps): ChannelRuntime;
  ```
  - 内部完成：`state` 初始化（`deps.state ?? new ChannelState()` + host/config/notifier 注入）、
    `logger`/`sleep` 缺省、`SerialTaskQueue`、`MediaStore`、`TypingController`、`MessageSender`、
    `MessageRouter`、`InboundHandler`、`CredentialLoader`、`PollingLoop` 的创建与回调注入。
  - `ChannelDeps` 仍定义在 `channel.ts`（公共类型），工厂从 `./channel.js` 以 `import type` 引入
    （避免运行时循环依赖）；若实现上更稳妥，也可把 `ChannelDeps`/`ChannelPorts` 定义搬到一个
    不 import Channel 的小模块——但**不得改变其对外导出名与用法**（index.ts / tests 不受影响）。

prod（修改）：
- `src/channel/channel.ts`
  - 构造函数改为：
    ```ts
    constructor(deps: ChannelDeps) {
      const runtime = createChannelRuntime(deps);
      this.state = runtime.state;
      this.logger = runtime.logger;
      this.credentialLoader = runtime.credentialLoader;
      this.poller = runtime.poller;
      this.typing = runtime.typing;
      this.sender = runtime.sender;
      this.router = runtime.router;
      this.inboundHandler = runtime.inboundHandler;
    }
    ```
  - 删除仅用于装配的字段 `sleep` / `mediaStore` / `mediaQueue`（移入工厂后 Channel 不再引用它们）。
  - 删除构造函数内所有 `new` / 回调注入代码；删除不再需要的私有 `getCurrentOpts()`（工厂直接用 `state.getOpts()`）。
  - 保留 `getCredentials()`（若仍有引用；否则一并移出并在 result 说明）。
  - 同步更新文件头注释。

tests：
- 期望**无需改动**：`new Channel(...)` 的公共构造签名不变，所有既有 channel/集成用例经工厂构造后应原样通过。
- 可选：新增 `tests/channel/create-channel.test.ts` 冒烟（断言 runtime 各字段存在且 `poller`/`inboundHandler` 已接线）。非必需。

## 行为契约（必须逐字保持）

工厂内协作类的回调与原 Channel 构造函数完全等价（只是从 `this.x` 改为局部变量）：

- `state`：`deps.state ?? new ChannelState()`；`deps.host/config/notifier` 存在时注入。
- `logger`：`deps.logger ?? createLogger({ isDebugEnabled: () => isDebugEnabled() })`。
- `sleep`：`deps.sleep ?? defaultSleep`（仅传给 poller）。
- `SerialTaskQueue` 错误处理：`logger.error("Media background task failed", err)`。
- `MediaStore`：`log/errLog` 绑定 `logger.debug/logger.error`（同现实现）。
- `TypingController`：`getContextToken: () => state.contextToken`；`debug/error` 绑定 logger。
- `MessageSender`：`canSend: () => state.getCredentials() !== null`；`debug/error` 绑定 logger。
- `MessageRouter`：`getHost: () => state.host`；`getOpts: () => state.getOpts()`；
  `isTerminalProcessing: () => state.isTerminalMessageProcessing`。
- `InboundHandler`：`{ state, typing, router, requestId: new RequestIdGenerator(), logger }`。
- `CredentialLoader`：`{ state, logger }`。
- `PollingLoop`：`ensureSession: () => credentialLoader.ensureSession()`；
  `getAccountId: () => state.accountId`；`loadCursor/saveCursor` → `storage.loadSyncCursor/saveSyncCursor`；
  `onMessage: (msg, opts) => inboundHandler.handle(msg, opts)`；
  `onNeedsRelogin`：`logger.debug("Session expired, needs relogin")` + `state.notifier?.(...)`；
  `debug/error` 绑定 logger；`sleep`。
- `Channel` 公共方法（`initSession/handleMessage/triggerAi/onAiDone/typing/send*/防重/reset`）行为不变。

## test-plan

- 既有 `tests/channel/*` 与 `tests/integration/channel-flow.test.ts` 全绿即可（构造路径已覆盖工厂）。
- 若新增冒烟测试，须精确断言（不得引入弱断言）。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] 新增 `src/channel/create-channel.ts`，导出 `createChannelRuntime`（及 `ChannelRuntime`）
- [ ] `Channel` 构造函数仅「调用工厂 + 赋值」，无 `new` 协作类、无回调注入代码
- [ ] `Channel` 已无 `sleep` / `mediaStore` / `mediaQueue` 字段
- [ ] `ChannelDeps` 公共类型与 `new Channel(...)` 用法不变；index.ts / tests 无需改动
- [ ] 行为契约逐条等价；`Channel` 公共方法与窄接口契约不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{create-channel,channel}.ts`、`tests/channel/**`
- [ ] result 的 test-changes ledger 完整
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、其它 `src/channel/*.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言

## report

完成后写 `/tmp/pi-tasks/cs-6.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-6`
