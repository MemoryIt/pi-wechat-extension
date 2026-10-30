status: done
branch: refactor/cs-6-channel-factory
commits:
- 70ece249475a10b4af4b0502e294e539c88911e5 refactor(channel): 抽出内部装配工厂 createChannelRuntime
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （194 pass / 23 files / 0 fail / 593 expect calls；与基线完全相同：
   194 / 23 / 0 / 593。typecheck 零错误；install frozen-lockfile 「no changes」）
test-changes:
  - 无。本阶段为纯内部装配重构，未改动任何测试文件
    （`git diff dev...HEAD --name-only` 仅 `src/channel/channel.ts`、
    `src/channel/create-channel.ts`）。
  - ledger：本阶段不存在用例的删除 / 修改 / 迁移；既有 194 个用例逐条原样通过，
    无断言削弱 / 无 expect 删除 / 无精确值放宽。
  - 覆盖面：`new Channel({ state, ports, logger })` 公共构造签名不变，所有既有
    channel / integration 用例经工厂构造路径原样执行，覆盖集合不缩小。
  - 本阶段无「用户可观察行为」新增，故按 task test-plan「可选」未新增
    `tests/channel/create-channel.test.ts` 冒烟（避免重复覆盖既有构造路径）。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 2 个文件：
  - src/channel/create-channel.ts（新增，+136）
  - src/channel/channel.ts（修改，+22 / -107）
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；
  package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、
  src/storage/**、src/index.ts、其它 src/channel/*.ts、tests/** 均零 diff；
  dev（d78d09d）为 merge-base，未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、
        0 fail、typecheck 零错误（194 pass / 23 files / 0 fail / 593 expect calls，
        与基线持平；install no changes）
  - [x] 新增 `src/channel/create-channel.ts`，导出 `createChannelRuntime` 及
        `ChannelRuntime`（`rg "export" src/channel/create-channel.ts` →
        `interface ChannelRuntime` / `function createChannelRuntime`）
  - [x] `Channel` 构造函数仅「调用工厂 + 赋值」：
        `const runtime = createChannelRuntime(deps);` + 8 行字段赋值；
        `rg "new |mediaStore|mediaQueue|this\\.sleep|getCurrentOpts|getCredentials"
        src/channel/channel.ts` 无任何命中（无 `new` 协作类、无回调注入代码）
  - [x] `Channel` 已无 `sleep` / `mediaStore` / `mediaQueue` 字段
        （这三个仅用于装配的局部量已移入工厂，`Channel` 不再引用）
  - [x] `ChannelDeps` 公共类型与 `new Channel(...)` 用法不变；
        `src/index.ts`、`tests/**` 零改动
        （`ChannelPorts` / `ChannelDeps` 仍定义并导出于 `channel.ts`；
        工厂以 `import type { ChannelDeps } from "./channel.js"` 复用，
         该 type-only import 运行期被擦除，不形成运行时循环依赖）
  - [x] 行为契约逐条等价（见 invariants）
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{create-channel,channel}.ts`
  - [x] result 的 test-changes ledger 完整（本阶段无测试改动）
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] 正常路径行为不变：工厂内协作类创建与回调注入与抽取前 `Channel` 构造函数逐字等价，
        仅将 `this.x` 改为局部变量：
        * `state = deps.state ?? new ChannelState()`；`deps.host/config/notifier` 存在时注入；
        * `logger = deps.logger ?? createLogger({ isDebugEnabled: () => isDebugEnabled() })`；
        * `sleep = deps.sleep ?? defaultSleep`（仅传给 poller）；
        * `SerialTaskQueue` 错误处理：`logger.error("Media background task failed", err)`；
        * `MediaStore`：`log/errLog` 绑定 `logger.debug/logger.error`（含
          `String(a[0] ?? "")` + 其余参数透传）；
        * `TypingController`：`getContextToken: () => state.contextToken`，`debug/error` 绑定 logger；
        * `MessageSender`：`canSend: () => state.getCredentials() !== null`，`debug/error` 绑定 logger；
        * `MessageRouter`：`getHost: () => state.host`、`getOpts: () => state.getOpts()`、
          `isTerminalProcessing: () => state.isTerminalMessageProcessing`、`logger`；
        * `InboundHandler`：`{ state, typing, router, requestId: new RequestIdGenerator(), logger }`；
        * `CredentialLoader`：`{ state, logger }`；
        * `PollingLoop`：`ensureSession` → `credentialLoader.ensureSession()`、
          `getAccountId` → `state.accountId`、`loadCursor/saveCursor` →
          `storage.loadSyncCursor/saveSyncCursor`、`onMessage` → `inboundHandler.handle`、
          `onNeedsRelogin` → `logger.debug("Session expired, needs relogin")` +
          `state.notifier?.("微信登录已失效，请执行 /wechat login 重新登录", "error")`、
          `debug/error` 绑定 logger、`sleep`。
  - [x] 构造顺序不变（router → inboundHandler → credentialLoader → poller），
        保证 poller 回调引用的 `inboundHandler` / `credentialLoader` 已初始化。
  - [x] `Channel` 公共方法与窄接口契约不变：
        `setHost/setNotifier/setConfig/connectionState/getTerminalProcessing/
        setTerminalProcessing/initSession/stopPolling/startPolling/handleMessage/triggerAi/
        onAiDone/getTypingTicket/sendTypingStatus/startTyping/stopTyping/sendText/sendFile/
        sendReply/getCurrentRequestId/isRequestProcessed/markRequestProcessed/reset`
        签名与行为不变（既有用例原样通过）。
  - [x] 文案不变（尤其 `"Media background task failed"`、`"Session expired, needs relogin"`、
        `"微信登录已失效，请执行 /wechat login 重新登录"`、`"Channel state reset"`）。
  - [x] 持久化 / 端口签名不变：`storage.loadSyncCursor/saveSyncCursor`、
        `storage.saveContextToken`、`WechatInbound/Outbound/Media` 端口调用点未改动。
  - [x] 删除的私有 `getCurrentOpts()`：仅被旧构造函数的 `getOpts` 回调引用，
        移入工厂后直接使用 `state.getOpts()`，无其它引用。
  - [x] 删除的私有 `getCredentials()`：仅被旧构造函数的 `canSend` 回调引用，
        移入工厂后直接使用 `state.getCredentials()`；`ChannelState.getCredentials()`
        公共方法未改动（仍由 `src/index.ts` 组合根注入 outbound 时使用）。
  - [x] 依赖方向不变：`channel.ts` 不再 import `../storage/state.js`、
        `../shared/config.js`、`../shared/time.js`、`createLogger` 及各协作类构造器；
        改为对协作类仅 `import type`；`create-channel.ts` 只依赖 `ports/`、
        `storage/`、`shared/` 与 `./*` 协作类（对 `channel.ts` 仅 type-only import）。
notes: |
  - 单一批量原子提交：本阶段为一个逻辑（把装配从 `Channel` 构造函数抽到内部工厂），
    新增工厂 + 修改 `Channel` 放入同一 commit，避免中间不可编译状态。
  - 工厂以 `import type` 复用 `ChannelDeps`（仍定义于 `channel.ts`，保持对外导出名
    与用法不变），未搬迁公共类型，`src/index.ts` 与 tests 均无需改动。
  - 测试策略：未新增/修改用例——`Channel` 公共构造签名与全部公共方法不变，既有
    194 用例经 `new Channel(...) → createChannelRuntime` 路径已充分覆盖装配正确性；
    task 明确将工厂冒烟测试列为「可选」且本阶段无用户可观察行为，故不引入重复覆盖。
  - 未决项 / 需 human 决策：无。
