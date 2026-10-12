status: done
branch: refactor/cs-5-inbound-handler
commits:
- 75ff996be3cac970063e334fdd137206765b6649 refactor(channel): 抽出入站处理器 InboundHandler，打破 poller 回调闭环
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （194 pass / 23 files / 0 fail / 593 expect calls；基线 188 / 22 / 0 / 556；
   typecheck 零错误；install frozen-lockfile 无改动）
test-changes:
  - 删除：tests/channel/channel.test.ts 的 D13 用例
    「D13 目标：同一毫秒内的 requestId 应保持唯一」
    （原经 `(channel as AnyChannel).generateRequestId()` 断言）。
    去向：**被蕴含（subsumed）**。
    依据：本阶段 `generateRequestId` 及 `Channel.requestId` 字段随生成逻辑迁出到
    `InboundHandler`（构造时注入 `RequestIdGenerator`），Channel 不再暴露该方法，
    该用例引用的私有成员已不存在。其不变量「同毫秒唯一 + 序号递增 + 跨毫秒归零 +
    18 位格式」由 `tests/channel/request-id.test.ts` 的 4 个用例确定性、且更强地覆盖
    （精确断言 `000/001/002` 后缀、跨毫秒归零、长度与正则、精确 15 位时间戳前缀）；
    本阶段新增的 `tests/channel/inbound-handler.test.ts` 第 1 例进一步断言
    `requestId.next()` 恰调用一次且 `dispatch` 收到该生成的 id。覆盖面不缩小、断言不削弱。
  - 修改：tests/channel/channel.test.ts 文件头注释（移除 D13 行，注明迁出去向）；
    删除随 D13 一并失效的 `setSystemTime` import（该文件不再使用）。
    其余既有用例（含 `handleMessage` / `triggerAi` / 媒体 / 队列 / typing 等）零改动，
    全部经 `Channel.handleMessage` 公共委托原样通过。
  - 新增 tests/channel/inbound-handler.test.ts（新增 7 用例、38 expect calls）：
    1. "contextToken 变化 + accountId/userId 齐全：更新 state、失效 ticket、
       精确持久化、按序 dispatch"
       - 冻结系统时钟，断言 `state.contextToken` 更新、`invalidateTicket` 恰 1 次、
         `logger.debug` 参数精确 `"Updating contextToken from message"`、
         `saveContextToken("acc1","U1",{displayName:"U1",contextToken:"CTX-NEW",
         lastMessageAt:<冻结值>})` 精确参数、`next` 恰 1 次、
         `dispatch(msg,"REQ-1",opts)`、调用顺序
         `["requestId","debug","invalidateTicket","saveContextToken","dispatch"]`。
    2. "contextToken 变化但 accountId/userId 缺失：更新 state + 失效 ticket，
       不持久化，仍 dispatch"（accountId 有、userId 无，验证与语义）。
    3. "contextToken 变化但 accountId 缺失：同样只更新 state + 失效 ticket，不持久化"。
    4. "context_token 缺失：无更新、无失效、无持久化、无 debug，仍 dispatch"。
    5. "context_token 为空串：视为缺失，无副作用，仍 dispatch"。
    6. "context_token 与当前相同：无副作用，仍 dispatch"。
    7. "工厂 createInboundHandler：返回 InboundHandler 且委托行为一致"
       （覆盖本阶段新增工厂公共行为）。
  - 覆盖对照 task test-plan：变化+凭证齐全 ✓；变化+凭证缺失（不持久化、仍 dispatch）✓；
    缺失 ✓；相同 ✓；空串（额外）✓；顺序/固定 requestId 精确断言 ✓；工厂 ✓。
  - 断言强度：全部使用 `toBe` 精确值 / `toHaveBeenCalledWith` 精确参数 /
    `toHaveBeenCalledTimes` 精确次数 / `toEqual` 精确数组；顺序用事件数组精确比对；
    无 toBeTruthy 弱化、无删 expect、无放宽精确值。唯一「删除」为 D13（被蕴含，理由如上）。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 4 个文件：
  - src/channel/channel.ts（修改，+ / -）
  - src/channel/inbound-handler.ts（新增）
  - tests/channel/channel.test.ts（修改，仅 D13 处理 + 头注释/import）
  - tests/channel/inbound-handler.test.ts（新增）
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；
  package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、
  src/storage/**、src/index.ts、其它 src/channel/*.ts（含 request-id/state/typing/router/
  polling/queue/sender/media-store/credential-loader/inbound-parser）、tests/setup/** 零 diff；
  dev（acfab37）为 merge-base，未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、
        typecheck 零错误（194 pass / 23 files / 0 fail / 593 expect calls；高于基线属新增用例）
  - [x] 新增 `src/channel/inbound-handler.ts`，导出 `InboundHandler` 及工厂
        `createInboundHandler`；仅依赖 `ports/types`、`shared/types`、`storage/state`、
        `./state`、`./request-id`、`shared/logger`（其中多数为 `import type`）
  - [x] `Channel` 的 `poller.onMessage` 指向 `inboundHandler.handle`
        （`rg "onMessage" src/channel/channel.ts` → `(msg, opts) => this.inboundHandler.handle(msg, opts)`；
        不再出现 `this.handleMessage`）
  - [x] `Channel.handleMessage` / `triggerAi` 为委托；签名不变；`Channel` 已无 `requestId`
        字段与 `generateRequestId`（`rg` 确认仅剩构造 `InboundHandler` 时注入的
        `requestId: new RequestIdGenerator()` 与 `triggerAi`/防重 API 的参数名）
  - [x] 行为契约逐条一致（顺序 + 条件持久化 + 缺失/相同分支），由新用例覆盖
  - [x] `Channel` 其余公共 API / 文案 / 持久化 / 端口签名不变
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{inbound-handler,channel}.ts`、
        `tests/channel/**`
  - [x] result 的 test-changes ledger 完整，无削弱断言
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] 正常路径行为不变：`InboundHandler.handle` 与原 `Channel.handleMessage` 主体逐字一致
        （requestId 生成 → contextToken 变化判定 → debug → 写 state → invalidateTicket →
        条件 `saveContextToken` → `router.dispatch`）
  - [x] 顺序契约：先生成 requestId；仅当 `msg.context_token` 非空且 !== `state.contextToken`
        才进入同步分支；持久化仅在 `state.accountId && state.userId` 时执行；最后 dispatch
        （inbound-handler.test.ts 第 1 例以事件数组精确断言）
  - [x] `context_token` 缺失 / 空串 / 与当前相同：零副作用（无 state 改动、无 invalidateTicket、
        无 saveContextToken、无 debug），仍 dispatch
  - [x] `Channel.handleMessage` / `triggerAi` 对外签名与行为不变（channel.test.ts 与
        integration/channel-flow.test.ts 的调用原样通过）
  - [x] `saveContextToken` 载荷不变：`{ displayName: userId, contextToken: msg.context_token,
        lastMessageAt: Date.now() }`，accountId/userId 取自 state
  - [x] debug 文案精确不变：`Updating contextToken from message`
  - [x] 依赖方向不变：`src/channel/inbound-handler.ts` 不 import vendor / engine / 适配层 /
        `Channel`
  - [x] 两个 poller 构造期回调均不再指回 `Channel` 方法：`ensureSession` →
        `credentialLoader.ensureSession()`（cs-4），`onMessage` → `inboundHandler.handle`（cs-5）
  - [x] `RequestIdGenerator` / `ChannelState` / `TypingController` 实现未改动；requestId
        格式与唯一性契约不变
notes: |
  - 单一批量原子提交：本阶段为一个逻辑（抽出入站处理协作者并打破回调闭环），prod
    新增/修改 + 测试新增/删除放入同一 commit，避免中间不可编译状态。
  - `Channel.handleMessage` 保留为公共委托（channel.test.ts / integration/channel-flow.test.ts
    多处调用），签名 `(msg, opts): Promise<void>` 与对外行为完全一致；`triggerAi` 保留公共
    委托（测试直接调用）。
  - `InboundHandler` 在构造函数中于 `router` 之后、`credentialLoader`/`poller` 之前创建，
    满足 `poller.onMessage` 引用；`requestId` 生成器以匿名实例注入（Channel 不再持有字段）。
  - D13 处理方式选择「被蕴含并删除」而非「迁移」：task 允许二选一；`request-id.test.ts`
    已对同一不变量给出确定性且更完整的断言，迁移只会产生重复覆盖，故按 test-policy 记为
    被蕴含并附依据。
  - 测试策略：`inbound-handler.test.ts` 用 `mock.module(repoPath("src","storage","state.js"))`
    注入仅含 `saveContextToken` 的 storage fake（在 import InboundHandler 前安装），配合
    fake state/typing/router/requestId/logger；`bun test --isolate` 保证不影响其它文件的
    真实 storage 路径。顺序断言通过各 fake 向共享事件数组追加事件实现。
  - 未决项 / 需 human 决策：无。
