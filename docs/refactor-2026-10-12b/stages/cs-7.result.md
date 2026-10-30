status: done
branch: refactor/cs-7-facade-narrowing
commits:
- 4054286205e41c7f67b8edfdc522874532de8216 refactor(channel): 收敛 facade 公共面，移除仅测试用/已死的转发方法
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （194 pass / 24 files / 0 fail / 593 expect calls；typecheck 零错误；
   install frozen-lockfile 完成、未改动 lockfile）
  基线：194 pass / 23 files / 0 fail。pass 与 expect 计数持平（删除 D16 三例 =
  新增 typing 三例，均为 11 expect），files 23 → 24（新增 typing.test.ts）。
test-changes:
  ledger（逐条给出原用例去向；无断言削弱）：
  - 删除 `tests/channel/channel.test.ts` → `D16 目标：contextToken 变化后应重新获取
    typing ticket` —— 去向：**迁移** → `tests/channel/typing.test.ts`
    「typing：contextToken 变化后应重新获取 ticket（原 D16-1）」。原断言
    `t1 toBe "T1"` / `t2 toBe "T2"` / `getTypingTicket toHaveBeenCalledTimes(2)`
    逐一保留（改为直接注入 fake `getContextToken`，不再经已删的 facade 方法）。
  - 删除 `channel.test.ts` → `D16 目标：ticket 缓存 60s TTL 内命中、过期后重新获取`
    —— 去向：**迁移** → `typing.test.ts`「typing：ticket 缓存 60s TTL 内命中、
    过期后重新获取（原 D16-2）」。保留 `Date.now` 覆盖手法与全部 5 条精确断言
    （2×`toBe` + 命中后 `toHaveBeenCalledTimes(1)` + 过期后 `toBe` +
    `toHaveBeenCalledTimes(2)`）。
  - 删除 `channel.test.ts` → `D16 目标：sendTyping 报错含 'ticket' 时清空缓存并重新获取`
    —— 去向：**迁移** → `typing.test.ts`「typing：sendStatus 报错含 'ticket' 时
    清空缓存并重新获取（原 D16-3）」。保留 `sendTyping toHaveBeenCalledWith(1, "T1")`、
    报错后 `getTicket toBe "T2"`、`getTypingTicket toHaveBeenCalledTimes(2)`。
  - `channel.test.ts` 的 `D16b 目标：typing keepalive 的 interval 应调用 unref`
    —— 去向：**原样保留**（`startTyping` / `stopTyping` 未删，方法仍在）。
  - `tests/integration/channel-flow.test.ts` 入站文本用例的 3 处
    `channel.getCurrentRequestId()` 断言 —— 去向：**等价改写**（被蕴含，非削弱）：
    * `expect(appendEntry[0][1]).toEqual({ requestId: channel.getCurrentRequestId() })`
      → 从 `appendEntry[0][1].requestId` 捕获记录值，与
      `(channel as ...).router.queue.getCurrentRequestId()` 以 `toBe` 精确比较，
      语义同为「本轮 requestId 一致」；
    * `expect(channel.getCurrentRequestId()).not.toBeNull()`
      → `expect(queue.getCurrentRequestId()).not.toBeNull()`（当前 turn 非空）；
    * `expect(channel.getCurrentRequestId()).toBeNull()`
      → `expect(queue.getCurrentRequestId()).toBeNull()`（onAiDone 后清空）。
      顺带把同用例既有的 `router.queue.size` 断言并入同一 cast 观察，值不变。
  - 其它用例零改动；无 `toBe→toBeTruthy`、无删 expect、无精确值放宽。
  - 覆盖面：被断言的外部行为集合不缩小——typing 缓存三条语义与 requestId 生命周期
    仍被精确断言，仅观察入口由 facade 转发改为直接协作类 / queue。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 4 个文件：
  - src/channel/channel.ts（-23）
  - tests/channel/channel.test.ts（+4 / -55）
  - tests/channel/typing.test.ts（新增，+94）
  - tests/integration/channel-flow.test.ts（+10 / -3）
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；
  package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、
  src/storage/**、src/index.ts、其它 src/channel/*.ts 零 diff；
  tests/setup/bridge-harness.ts 的 fake `getTerminalProcessing` 未动。
  dev 为 merge-base（`git log --oneline dev..HEAD` 仅本阶段 1 个 commit）；
  未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、
        0 fail、typecheck 零错误（194 pass / 24 files / 0 fail / 593 expect calls）
  - [x] `rg "getTerminalProcessing|getTypingTicket|sendTypingStatus|getCurrentRequestId|
        sendText" src/channel/channel.ts` 无命中（exit 1，5 个方法已删）
  - [x] 新增 `tests/channel/typing.test.ts`，直接测 `TypingController`，覆盖原 D16
        三条语义（3 pass / 0 fail）
  - [x] `channel.test.ts` 的 D16 三例已迁移删除、D16b 保留（line 311）；集成测试
        requestId 观察语义不变（相等 / 非空 / 排空后为 null）
  - [x] `Channel` 其余公共 API / 窄接口契约不变：保留
        `setHost/setNotifier/setConfig/connectionState/setTerminalProcessing/
        initSession/stopPolling/startPolling/handleMessage/triggerAi/onAiDone/
        startTyping/stopTyping/sendFile/sendReply/isRequestProcessed/
        markRequestProcessed/reset`；未删 `handleMessage/triggerAi/
        setTerminalProcessing/startTyping/stopTyping/isRequestProcessed/
        markRequestProcessed`；`sendFile` 保留（生产 `tool-send-file` 仍用）
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/channel.ts`、
        `tests/channel/**`、`tests/integration/**`
  - [x] result 的 test-changes ledger 完整（删除的 D16 三例标「迁移」），无削弱断言
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] 正常路径行为不变：移除的 5 个方法均为纯转发/无生产调用
        （`getTerminalProcessing`→`state.isTerminalMessageProcessing`、
        `getTypingTicket`→`typing.getTicket`、`sendTypingStatus`→`typing.sendStatus`、
        `sendText`→`sender.sendText`、`getCurrentRequestId`→`router.queue.*`），
        删除不触碰任何运行时编排路径。
  - [x] 文案不变：未修改任何 `logger` / notify / ack 文案。
  - [x] 持久化 / 端口签名不变：`storage.*`、`WechatInbound/Outbound/Media` 调用点未动。
  - [x] 协作类端口不变：`TypingController` / `MessageSender` / `MessageRouter` /
        `InboundHandler` / `PollingLoop` / `CredentialLoader` 定义与装配
        （`create-channel.ts`）零改动。
  - [x] import 无 `noUnusedLocals` 问题：`TypingController` 仍作字段类型使用、
        `MessageSender` 仍作字段类型使用；typecheck 零错误。
  - [x] bridge 侧无回归：`tests/bridge/*` 的 `channel.getTerminalProcessing()` 调用
        对象是 `tests/setup/bridge-harness.ts` 的 fake `BridgeChannel`（自带该 mock），
        与真 `Channel` 无关；该 harness 未改动，bridge 用例全绿。
  - [x] `tests/integration/channel-flow.test.ts` 的 queue cast 复用既有字段路径
        （`channel.router.queue`），仅测试内部观察，不改生产可见面。
notes: |
  - 单一批量原子提交：src 删除 + 测试迁移属同一逻辑（facade 收敛，测试同步改为
    直接观察协作类），拆开会产生「测试引用已删方法」的不可编译中间态，故合为一个
    `refactor(channel): ...` commit。
  - 迁移策略：原 D16 经 `Channel` 转发方法观测 `TypingController` 缓存，改为直接
    构造 `TypingController` 并注入 fake `outbound` + 可变 `getContextToken`，断言强度
    与 expect 数量完全一致（11 → 11），因此总 expect 与 pass 计数与基线持平。
  - `getTerminalProcessing` 虽被 `tests/bridge/*` 文本调用，但那是 fake Channel 的
    mock（`bridge-harness.ts`），任务明确禁止改动该 harness，且任务书判定真
    `Channel.getTerminalProcessing` 生产 0 调用、删除无测试改动，验证一致。
  - 未决项 / 需 human 决策：无。
