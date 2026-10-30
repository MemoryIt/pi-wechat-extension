# Task: RF-7 修 F6 —— 媒体批次错误不再阻断后续消息 / cursor

base: dev
branch: refactor/rf-7-f6-resilience
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 167 pass / 19 files / 0 fail（不得减少；新增用例计入）
invariant: 正常路径行为不变；公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 现象（F6）
微信先连发多张图片、再发一条文本时，文本疑似被阻塞（长时间无响应）。

## 已定位的根因（请先用代码 + 测试确认，再修）
1. **轮询按消息处理时无单条隔离**：`src/channel/polling.ts` 的循环里
   `for (const msg of updates.messages) { await this.deps.onMessage(msg, opts); }`
   任一 `onMessage` 抛错会中断整个 for 循环并冒泡到 catch：
   - 同一批次里后续消息（含正文）被丢弃；
   - 其后的 `syncCursor = updates.cursor` 与 `saveCursor(...)` **不会执行** → cursor 不前进。
2. **媒体 ack 在关键路径且会抛错**：`src/channel/router.ts` 媒体分支里
   `await this.deps.sender.sendText("媒体文件已收到，正在保存…")` 未捕获异常。
   凭证/Ctx 暂缺或网络失败时 ack 抛错 → 传播到 `onMessage` → 触发上面的 1。

组合效果：多张图片 → ack 抛错 → 批次中断 + cursor 不前进 → 服务端重投旧批次 →
再次 ack 抛错……形成重投循环，后续文本永远取不到（即 F6）。

## goal
让「单条消息处理失败」不再影响同批次其它消息与 cursor 前进：
- 轮询循环对每条消息单独 try/catch（记录错误、继续处理下一条）；只要 `getUpdates` 成功，
  就更新并持久化 cursor。
- 媒体 ack 失败只记录日志，不抛给调用方、不影响后台下载入队 / 标记已处理 / 队列排空。

## scope
- prod（修改）：
  - `src/channel/polling.ts`：为 `await this.deps.onMessage(msg, opts)` 包 try/catch，错误经
    `this.deps.error(...)` 记录后继续；`syncCursor`/`saveCursor` 逻辑保持在其后执行。
  - `src/channel/router.ts`：媒体 ack 用 try/catch 包裹（失败 `logger.error(...)`），其余步骤
    （`mediaQueue.enqueue` / `markRequestProcessed` / `drain`）照常执行。
- tests（新增/修改）：
  - `tests/channel/polling.test.ts`（新增，直接单测 `PollingLoop` + fake deps）：
    - `onMessage` 对某条消息抛错时，同批次其余消息仍被处理；`saveCursor` 仍以批次 cursor 调用
  - `tests/channel/channel.test.ts`（新增用例）：
    - 一个批次含「图片消息 + 文本消息」，媒体 ack（`outbound.sendText` 第一次调用）抛错 →
      文本 turn 仍到达宿主（`sendUserMessage` 被调用）且 cursor 已持久化

## 行为契约（必须保持）
- 正常（无错误）路径：处理顺序、ack 文案、`markRequestProcessed`、队列排空、cursor 持久化不变。
- 轮询错误处理：`getUpdates` 本身失败仍走原有「退避 + error 状态」逻辑（本次只隔离**单条** `onMessage` 失败）。
- `onMessage` 失败不改变 `connectionState`（该批次视为成功）。
- 仍遵守 `abortSignal`/generation 检查（循环内 break 条件不变）。

## test-plan
- [ ] `tests/channel/polling.test.ts`：
  - 批次 `[m1, m2]`，`onMessage` 对 `m1` 抛错 → 仍调用 `m2`；`error` 被调用一次；
    `saveCursor(accountId, batchCursor)` 被调用
  - 正常批次 `[m1, m2]` → 两者都处理、无 error、cursor 持久化
  - 用「首次 getUpdates 返回批次、后续挂起」+ `stop()` 结束循环，避免无限轮询
- [ ] `tests/channel/channel.test.ts` F6 用例：
  - `outboundMock.sendText.mockRejectedValueOnce(new Error("ack failed"))`
  - getUpdates 首批返回 `[图片消息, 文本消息]`，cursor `"cursor-f6"`
  - 断言：`pi.calls.sendUserMessage` 含文本；`await storage.loadSyncCursor("acc1") === "cursor-f6"`
  - 结束后 `stopPolling` 并 resolve 挂起请求，`await p`

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 167
- [ ] `src/channel/polling.ts` 对单条 `onMessage` 失败做隔离；`saveCursor` 在批次成功时仍执行
- [ ] `src/channel/router.ts` 媒体 ack 失败不抛、不阻断入队/标记/排空
- [ ] 新增两条回归用例（polling 隔离 + channel 级 F6），且**修复前会失败、修复后通过**
      （result 中说明如何确认「修复前失败」）
- [ ] 既有 `tests/channel/router.test.ts` / `channel.test.ts` 的媒体基线用例仍通过、断言未削弱
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{polling,router}.ts`、`tests/channel/**`
- [ ] result 中写明确认的根因与修复点对应关系
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、
  `src/channel/` 下 polling.ts / router.ts 以外的文件
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言

## report
完成后写 `/tmp/pi-tasks/rf-7.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-7`
