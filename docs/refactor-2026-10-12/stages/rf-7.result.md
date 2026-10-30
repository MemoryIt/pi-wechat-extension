status: done
branch: refactor/rf-7-f6-resilience
commits:
- 1812bcc fix(channel): 隔离轮询中单条消息处理失败
- 1f535de fix(channel): 媒体 ack 失败仅记录日志，不再阻断批次与队列

tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （171 pass / 20 files / 0 fail / 491 expect calls；基线 167 / 19 / 0，新增 4 例；
  typecheck 零错误；bun install --frozen-lockfile 131 installs 无变更、无新增依赖）

root-cause-confirmed: |
  用代码 + 新增测试双重确认任务书根因：
  1. src/channel/polling.ts 批次循环 `for (const msg of updates.messages) await this.deps.onMessage(...)`
     无单条隔离：任一 onMessage 抛错 → 中断整个 for + 冒泡到外层 catch（走「退避 + error」路径），
     syncCursor/saveCursor 不执行 → cursor 不前进。
  2. src/channel/router.ts 媒体分支 `await this.deps.sender.sendText("媒体文件已收到，正在保存…")`
     未捕获 → ack 失败（凭证/Ctx 暂缺或网络失败）传播到 onMessage，触发 1。
  组合：多图 → ack 抛错 → 批次中断 + cursor 不回写 → 服务端重投旧批次 → 再抛错……重投循环，
  后续文本永远取不到（F6）。
  修复前失败确认：新加的两条回归用例在修复前跑失败——
  - tests/channel/polling.test.ts「F6 目标：某条 onMessage 抛错时…」：failed（processed=[] 而非 ["m2"]，
    saveCursor 未调用）；
  - tests/channel/channel.test.ts「F6 目标：媒体 ack 抛错后同批次文本仍交给宿主且 cursor 已持久化」：
    failed（waitFor sendUserMessage 超时，服务端批次被 ack 抛错中断，文本未送达）。
  修复后两条均通过；基线正常路径用例（polling 正常批次 / router 媒体 ack 正常）全程绿。

fix-map:
  - polling.ts（F6 根因 1）：批次循环内对 `await this.deps.onMessage(msg, opts)` 包 try/catch，
    失败经 `this.deps.error("[Wechat] Failed to handle message, continuing:", errMsg)` 记录后 continue；
    syncCursor = updates.cursor 与 saveCursor 保持在循环之后执行（getUpdates 成功即回写，批次视为成功）。
    getUpdates 自身失败 / POLL_ABORTED / 会话过期 / generation 检查逻辑原样保留；onMessage 失败不改变
    connectionState（不再落入「退避 + error」）。
  - router.ts（F6 根因 2）：媒体 ack `sendText` 用 try/catch 包裹，失败
    `logger.error("Media ack failed (requestId=…)", errMsg)` 后照常
    mediaQueue.enqueue / markRequestProcessed / drain；ack 文案不变。

test-changes: 新增 3 文件/用例组，修改 1（非削弱，仅更换触发机制）
  - 新增 tests/channel/polling.test.ts（2 例，直接单测 PollingLoop + fake deps）：
    「某条 onMessage 抛错 → 同批次 m2 仍处理、error 记 1 次、saveCursor(acc1, cursor-batch) 仍调用」；
    「正常批次 [m1,m2] → 都处理、无 error、cursor 持久化」。用「首次 getUpdates 返回批次、后续挂起」+
    stop() 结束循环。
  - tests/channel/channel.test.ts 新增「F6 目标：媒体 ack 抛错后同批次文本仍交给宿主且 cursor 已持久化」：
    首批 [图片, 文本]、cursor "cursor-f6"、outboundMock.sendText.mockRejectedValueOnce 抛 "ack failed"，
    断言 sendUserMessage 含文本、loadSyncCursor("acc1")==="cursor-f6"；随后 stopPolling + resolve 挂起请求。
  - tests/channel/router.test.ts 新增「媒体 ack 失败不抛，仍标记处理并照常入后台队列」；
    修改「router.drain：execute rejection 被捕获并释放状态」：F6 后 ack 失败已在 execute 内部隔离，
    不再能让媒体分支 reject，故改为直接令 h.router.execute 拒绝来测 drain 兜底——三条断言
    （busy=false / currentRequestId=null / 记录 Failed to process queued message）全部保留，未削弱。

scope-check: 未越界。`git diff dev...HEAD --stat` 仅 5 个文件：
  - src/channel/polling.ts（+9/-1：单条 onMessage try/catch）
  - src/channel/router.ts（+8/-1：媒体 ack try/catch）
  - tests/channel/polling.test.ts（新增 124 行）
  - tests/channel/channel.test.ts（+40：F6 回归用例）
  - tests/channel/router.test.ts（+28/-6：F6 用例 + drain 用例改触发机制，断言未削弱）
  核对为空的项：
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖。
  - src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/channel/ 下 polling.ts/router.ts
    以外的文件（queue/media-store/sender/channel/state/typing/request-id 等）零 diff；src/index.ts 零 diff。
  - 未 push（本分支仅 2 个本地 commit，dev..HEAD 无外推）；dev 未改（dev 仍为 7f9e10c，是分支起点）。

acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，171 pass / 20 files ≥ 167 / 19，0 fail；typecheck 零错误
  - [x] src/channel/polling.ts 对单条 onMessage 失败做隔离（try/catch + this.deps.error 后 continue）；
        saveCursor 在 getUpdates 成功的批次后仍执行（syncCursor 更新逻辑保持在循环之后）
  - [x] src/channel/router.ts 媒体 ack 失败仅 logger.error，不抛；mediaQueue.enqueue / markRequestProcessed / drain 照常
  - [x] 新增两条 F6 回归用例（polling.test.ts 隔离用例 + channel.test.ts F6 用例）修复前失败、修复后通过
        （见 root-cause-confirmed：修复前 one failed=[]，一个 waitFor 超时；修复后均绿）
  - [x] 既有 tests/channel/router.test.ts 媒体基线用例（立即 ack / 后台下载写 history）与
        channel.test.ts B5 媒体用例原样通过；drain rejection 用例三条断言均保留（仅更换制造 rejection 的机制）
  - [x] `git diff dev...HEAD --stat` 仅限 src/channel/{polling,router}.ts、tests/channel/**
  - [x] 提交原子：两个逻辑 commit（polling 隔离与 router ack 隔离各自独立、各自可绿），message 规范
        （fix(channel): …）

invariants:
  - [x] 正常无错误路径：批次处理顺序、ack 文案「媒体文件已收到，正在保存…」、markRequestProcessed、
        队列排空、cursor 持久化不变（既有基线用例原样通过）
  - [x] getUpdates 自身失败仍走原「退避 + error 状态 / needs_relogin」逻辑（外圈 catch 未动，
        仅隔离单条 onMessage 失败）
  - [x] onMessage 失败不改变 connectionState（该批次视为成功）；abortSignal / generation 检查与
        break 条件原样保留（循环内每条消息处理前仍检查）
  - [x] 公共 API / 文案（除新增日志行外）/ 持久化 / 端口签名均未改动；新增日志行不改变可观测对外行为

notes: |
  - 修复前失败证据：polling.test.ts 新用例失败时 processed=[]（m2 被丢弃）、saveCursor 零调用；
    channel.test.ts F6 用例失败时 waitFor 1s 超时（ack 抛错中断批次，文本 sendUserMessage 从未触发）。
    两个失败点精确对应任务书根因 1/2，修复后两条用例同时转绿，证明根因确认成立。
  - router.test.ts 既有 drain rejection 用例的修改不涉及断言削弱：断言集（isBusy=false、
    getCurrentRequestId=null、loggerErrors 含 Failed to process queued message）原样保留，
    仅因 F6 后媒体 ack 不再能令 execute 拒绝，把「制造 rejection」的方式改为直接令 execute 抛出，
    测试意图（drain 对 execute rejection 的兜底释放）不变。
  - 未决项 / 需 human 决策：无。