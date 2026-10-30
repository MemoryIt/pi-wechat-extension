# Verify result: RF-7（独立复验）

status: PASS
verifier: 独立验证 Agent（只读复验；只写本报告，未修改代码/未提交/未 push）
base-branch: dev = refactor/rf-7-f6-resilience 起点（merge-base = dev 7f9e10c）
verified-commit: 1f535de（HEAD，detached，branch refactor/rf-7-f6-resilience 仅 2 个 commit）

## 0. 环境与前置
- 当前 worktree `/workspace/wt-rf-7-verify` 于验证前 detached 在 1f535de，`git status` 干净。
- `bun install --frozen-lockfile`：130 packages installed，安装后 `git status` 仍干净（bun.lock 无变更）。

## 1. 全量门禁（HEAD）
```
bun install --frozen-lockfile => OK（130 packages，无变更）
bun run typecheck            => OK（tsc --noEmit 零错误）
bun run test                 => 171 pass / 0 fail / 491 expect() calls / Ran 171 tests across 20 files [922ms]
```
- 与 `rf-7.result.md` 声明完全一致（171 pass / 20 files / 0 fail / 491 expect；基线 167/19/0，+4 例）。
- 测试数 ≥ 基线且未减少：167 → 171（+4：polling.test.ts 2 例 + channel.test.ts F6 1 例 + router.test.ts F6 1 例）。

## 2. 范围核对（越界检查）
```
git diff dev...HEAD --stat =>
 src/channel/polling.ts        |  9 ++-
 src/channel/router.ts         |  8 ++-
 tests/channel/channel.test.ts | 40 ++++++++++++++
 tests/channel/polling.test.ts |124 ++++++++++++++++++++++++++++++++
 tests/channel/router.test.ts  | 28 ++++++++--
 5 files changed, 203 insertions(+), 6 deletions(-)
```
- 仅限 `src/channel/{polling,router}.ts` 与 `tests/channel/**`，未越界。
- vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）、src/ports、src/adapters、src/application、
  src/bridge、src/index.ts、src/channel/ 其余文件：零 diff（`git diff dev...HEAD --stat` 对上述路径输出行数为 0）。
- package.json / bun.lock：零 diff，未新增依赖。

## 3. 代码改动逐条核对（对照 rf-7.md behavior-contract）

### polling.ts（F6 根因 1）
- 批次循环内 `await this.deps.onMessage(msg, opts)` 已包 try/catch：失败 →
  `this.deps.error("[Wechat] Failed to handle message, continuing:", errMsg)` 后 continue。
- `this.state.syncCursor = updates.cursor; saveCursor(...)` 保持在循环**之后**，getUpdates 成功后必然执行；
  `consecutiveFailures = 0; connectionState = "connected"` 在该路径中原样保留 → onMessage 失败不改变连接状态、批次视为成功。
- 外圈 catch（getUpdates 失败 → POLL_ABORTED/会话过期/退避 2s·n 封顶 30s + error 状态）**未改动**。
- abortSignal / generation 检查与 break 条件原样保留（循环内每条消息处理前仍检查）。
- 正常路径顺序不变（既有基线用例全绿）。

### router.ts（F6 根因 2）
- 媒体分支 ack `sendText("媒体文件已收到，正在保存…")` 已包 try/catch：失败 →
  `logger.error("Media ack failed (requestId=…)", errMsg)`，文案不变、不抛给调用方。
- `mediaQueue.enqueue(...)` / `queue.markRequestProcessed(requestId)` / `drain()` 均在其后原样执行。

## 4. 新增回归用例真实性（覆盖「ack 失败 → 文本仍到达宿主 + cursor 持久化」）
- `tests/channel/polling.test.ts`（新增 124 行，直接单测 PollingLoop + fake deps）：
  - F6 用例：批次 [m1, m2]，onMessage(m1) 抛错 → 断言 processed == ["m2"]、error 恰好 1 次、saveCursor("acc1","cursor-batch") 被调用；
  - 基线用例：正常批次 [m1, m2] → 都处理、无 error、saveCursor("acc1","cursor-ok")；
  - 用「首次 getUpdates 返回批次、后续挂起」+ stop() 结束循环，符合任务书 test-plan。
- `tests/channel/channel.test.ts` 新增 F6 用例：首批 [图片, 文本]、cursor "cursor-f6"、
  `outboundMock.sendText.mockRejectedValueOnce(new Error("ack failed"))`；
  断言 `pi.calls.sendUserMessage` 含 "after images"、`storage.loadSyncCursor("acc1") === "cursor-f6"`；
  结束处 stopPolling + resolve 挂起请求 + await p。符合任务书 test-plan。
- `tests/channel/router.test.ts` 新增「媒体 ack 失败不抛，仍标记处理并照常入后台队列」：
  `resolves.toBeUndefined()`、loggerErrors 含 "Media ack failed"、isRequestProcessed("M3")、downloadAll 被调用。
  既有媒体基线用例（「立即 ack、入后台队列、不占用忙闲」「下载完成后写 history」，router.test.ts:125/138）**未修改**。

## 5. 修复前必败 / 修复后通过（关键独立验证）
用单独临时 worktree（/tmp/rf7-dev-check，detached @ dev 7f9e10c）+ HEAD 版测试文件，跑全量：

- **dev（未修复源码）+ HEAD 测试**：`bun run test` =>
  ```
  168 pass / 3 fail / 482 expect / 20 files
  (fail) F6 目标：媒体 ack 失败不抛，仍标记处理并照常入后台队列             [0.22ms]
  (fail) F6 目标：媒体 ack 抛错后同批次文本仍交给宿主且 cursor 已持久化    [1002.73ms]（waitFor 超时：文本未送达）
  (fail) F6 目标：某条 onMessage 抛错时，同批次剩余消息仍被处理且 cursor 仍持久化 [6.12ms]（processed=[]，m2 被丢弃）
  ```
  3 条新增 F6 回归全部失败，失败点精确对应任务书根因 1/2；其余 168 条既有用例全绿。
- **HEAD（已修复）**：171 pass / 0 fail（§1）。
- 另独立验证提交原子性：在 1812bcc（仅 polling 修复）临时 worktree 跑全量 →
  `169 pass / 0 fail / 484 expect / 20 files`（167 基线 + polling 2 例）；typecheck 零错误；
  1f535de（router 修复）→ 171 pass。两个 commit 各自独立可绿、各自只带本逻辑 + 对应测试。
- 说明：`tests/channel/channel.test.ts` 单独运行（dev 与 HEAD 均如此）会因 harness 的
  `mock.module("util/logger")` 未导出 setLogLevel 报 SyntaxError——这是**既有** harness 特性
  （HEAD 单独跑同样报错，dev 原始版本同），full-suite 下不出现；故 dev/HEAD 对比采用 full-suite，
  结论不受影响（该用例在 HEAD full-suite 通过、dev full-suite 失败点正是 waitFor 超时）。

## 6. 其余核对
- 正常路径行为未变：文本/媒体基线用例全绿；「router.drain：execute rejection 被捕获并释放状态」三条断言
  （isBusy=false、getCurrentRequestId=null、loggerErrors 含 "Failed to process queued message"）原样保留，
  仅将制造 rejection 的机制从「sender.sendText 抛错使媒体分支 reject」改为「直接令 execute 抛错」
  （F6 后 ack 失败已在 execute 内部隔离，不再能令媒体分支 reject）——测试意图不变、断言未削弱。
- getUpdates 自身失败的退避/错误逻辑（POLL_ABORTED / needs_relogin / consecutiveFailures++ /
  connectionState="error" / 2s·n 退避）未改动。
- 提交原子且 message 规范：1812bcc `fix(channel): 隔离轮询中单条消息处理失败`（仅 polling.ts + 新 polling.test.ts）；
  1f535de `fix(channel): 媒体 ack 失败仅记录日志，不再阻断批次与队列`（仅 router.ts + channel/router 测试）。各含正文说明根因。
- 未 push：origin 仅有 origin/main、origin/dev；`git branch -r --contains 1f535de/1812bcc` 均为空；
  dev 未改（merge-base = dev = 7f9e10c）。

## 结论
全部 check 项通过。测试计数、范围、根因对应、修复前必败/修复后通过、基线未削弱、
vendor/lock 零 diff、提交原子/未 push 均独立复核成立。**PASS**

## 清理
临时 worktree（/tmp/rf7-dev-check、/tmp/rf7-c1-check）已 `git worktree remove --force` 并 prune；
验证 worktree 恢复 detached @ 1f535de、工作树干净；无任何代码修改/提交/push。