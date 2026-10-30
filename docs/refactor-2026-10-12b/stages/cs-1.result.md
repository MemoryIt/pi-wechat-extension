status: done
branch: refactor/cs-1-turn-orchestration
commits:
- 27e87b26e264b1a14d3d5b3bbcfeb7137b13e65d refactor(channel): MessageRouter 成为 turn 编排唯一入口
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（176 pass / 20 files / 0 fail / 511 expect calls；基线 171 / 20 / 0；typecheck 零错误）
test-changes: 新增 5，修改 3 个文件（构造/harness/观察路径），重命名 0，删除 0
  - tests/channel/router.test.ts（修改）
    - harness `makeHarness` 补 `isTerminalProcessing`（默认 `() => false`，可 override）；`queue` 仍经 RouterDeps 注入以便观察（router 暴露 `readonly queue`）。
    - 既有 8 例（execute 文本 3 / 媒体 3 / drain 3，含 F6）断言零改动，仅 harness 补字段：无削弱。
    - 新增 `dispatch` 3 例：
      1. dispatch 空闲 -> 直接 execute（appendEntry("wechat_meta",{requestId:"D1"}) + sendUserMessage("hello",{deliverAs:"followUp"})，队列空、busy=true、currentRequestId="D1"）；
      2. dispatch 忙 -> 入队 1 条、不调用 execute、currentRequestId 为 null；
      3. dispatch 终端处理中 -> 入队 1 条、不调用 execute、busy=false。
    - 新增 `onTurnDone` 2 例：
      4. 有排队 -> 同步清 busy/currentRequestId，20ms 后队首被执行（内容 "next"、队列清空）；
      5. 空队列 -> 仅释放忙闲，不再执行。
  - tests/channel/channel.test.ts（修改，仅观察路径同步）
    - D6、D7（2 处）、B6（2 处）、B5 共 6 处 `(channel).queue` -> `(channel).router.queue`；行为断言（busy/size 精确值）逐字不变，无削弱。
  - tests/integration/channel-flow.test.ts（修改，仅观察路径同步）
    - 2 处 `(channel).queue` -> `(channel).router.queue`（size=1 / isBusy=false）；行为断言不变，无削弱。
  - 目的地汇总：无「迁移/被蕴含/失效」的删除用例；全部既有断言保留。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 5 个文件：
  - src/channel/router.ts（RouterDeps.queue 可选 + 新增 isTerminalProcessing；暴露 readonly queue；新增 dispatch/onTurnDone；execute/drain 内 queue 引用改 this.queue）
  - src/channel/channel.ts（删除 TurnQueue 字段与 import；router 自建队列并注入 isTerminalProcessing；triggerAi/onAiDone 委托；防重与 reset 委托 router.queue）
  - tests/channel/router.test.ts、tests/channel/channel.test.ts、tests/integration/channel-flow.test.ts
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、src/storage/**、src/index.ts 零 diff；
  dev（996e347）为 HEAD 祖先；未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（176 pass / 20 files / 0 fail；允许低于/高于 baseline）
  - [x] `src/channel/channel.ts` 不再声明 TurnQueue 字段（`rg "this\.queue|private readonly queue|TurnQueue" src/channel/channel.ts` 无命中）；triggerAi -> `router.dispatch`、onAiDone -> `router.onTurnDone`
  - [x] `MessageRouter` 提供 `dispatch` / `onTurnDone`，并拥有 `readonly queue`；队列状态迁移（setBusy/setCurrentRequestId/enqueue/dequeue）仅在 router 内改写
  - [x] 文本 / 媒体 / 错误 / 排空四条路径行为与契约一致；D1/F6 用例仍通过（router.test.ts 文本成功保持 busy、F6 媒体 ack 失败隔离）
  - [x] `Channel` 公共 API（triggerAi/onAiDone/getCurrentRequestId/isRequestProcessed/markRequestProcessed/reset 等）签名与语义不变；窄接口契约未破坏
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{channel,router}.ts`、`tests/channel/**`、`tests/integration/**`
  - [x] result 的 test-changes ledger 完整，无削弱断言
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] 正常路径行为不变：文本 turn 成功后 busy=true / currentRequestId=requestId，等待 onTurnDone（D1）
  - [x] host 缺失 / sendUserMessage 同步抛错：不冒泡、释放忙闲、markRequestProcessed、有排队则排空
  - [x] 纯媒体：立即 ack（失败仅记日志不阻断，F6）-> 后台串行队列 -> markRequestProcessed -> 不占忙闲 -> 有排队则排空
  - [x] dispatch 门控语义等价：`queue.isBusy() || isTerminalProcessing()` -> enqueue，否则 execute
  - [x] drain：20ms 延迟；空队列释放忙闲；否则出队执行；execute rejection 被捕获并释放状态（D1）
  - [x] D2：markRequestProcessed 仍只在发送成功后由 ReplyService 调用（未改 ReplyService）
  - [x] D13：requestId 生成仍在 Channel（generateRequestId），未迁移
  - [x] Channel 公共方法签名 / 文案 / 持久化 / 端口签名不变
notes: |
  - 单一批量原子提交：本次为一个逻辑（收敛 turn 编排入口），prod 修改与测试同步放入同一 commit，
    避免留下「router 已要求 isTerminalProcessing 但 channel 未注入」的中间不可编译状态。
  - MessageRouter 未注入 queue 时自建 `TurnQueue`；Channel 构造不再传 queue，仅注入 `isTerminalProcessing`，
    从而 `Channel` 彻底不再持有队列字段。
  - 测试中队列观察统一走 `router.queue`（严格等价于原 `channel.queue` 同一实例），断言强度不变。
  - 未决项 / 需 human 决策：无。
