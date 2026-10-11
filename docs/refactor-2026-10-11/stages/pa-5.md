# Task: PA-5 拆分通道编排到 channel/ + WechatEngine 退化为薄门面 + 通道集成测试

base: dev
branch: refactor/pa-5-channel-split
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 121 pass / 14 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、WechatEngine 公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
把 `WechatEngine` 里的**通道编排逻辑**下沉到 `src/channel/`：
1) 把协作类从 `src/engine/` **移动到** `src/channel/`（纯移动 + import 更新）；
2) 新增 `src/channel/channel.ts` 的 `Channel` 作为粗粒度编排器，承载原 `WechatEngine` 的编排逻辑；
3) `src/engine/wechat.ts` 的 `WechatEngine` **退化为薄门面**，公共 API 与行为完全不变（bridge 仍走旧入口）；
4) 新增 `tests/integration/channel-flow.test.ts`：**假 pi 宿主 + 真 Channel + 假端口**，覆盖入站/媒体/typing/出站。

## scope
- prod（移动，git mv 保留历史更好）：
  - `src/engine/polling.ts`   → `src/channel/polling.ts`
  - `src/engine/queue.ts`     → `src/channel/queue.ts`
  - `src/engine/router.ts`    → `src/channel/router.ts`
  - `src/engine/media-store.ts` → `src/channel/media-store.ts`
  - `src/engine/typing.ts`    → `src/channel/typing.ts`
  - `src/engine/sender.ts`    → `src/channel/sender.ts`
- prod（新增）：
  - `src/channel/channel.ts` → `Channel`（粗粒度编排器，见下）
- prod（修改）：
  - `src/engine/wechat.ts`（薄门面，委托 Channel；导出保持不变）
- tests：
  - 更新所有对移动文件的 import（`tests/engine/{queue,media-store,router}.test.ts`、`tests/setup/engine-harness.ts`、`tests/unit/*` 如有）
  - 新增 `tests/integration/channel-flow.test.ts`

## Channel 设计（`src/channel/channel.ts`）
`Channel` 承载原 `WechatEngine` 的编排逻辑，持有：`ChannelState` + `PollingLoop` + `TurnQueue` +
`SerialTaskQueue` + `MediaStore` + `TypingController` + `MessageSender` + `MessageRouter`。
- 构造：`new Channel(deps?: ChannelDeps)`，`ChannelDeps` 含可选 `{ state?, host?, config?, notifier?, ports?: { inbound?, outbound?, media? }, logger?, sleep? }`；
  未提供 ports 时用 `createWechatInbound/Outbound/Media` 默认实现（**adapter 构造仍在此处**，供后续 S6 迁移到 index）。
- 粗粒度公共 API（供 bridge 经 S6 直接使用；S5 由 WechatEngine 委托）：
  - `setHost(host)` / `setConfig(config)` / `setNotifier(notifier)` / `configure(deps)`
  - `get connectionState`
  - `getTerminalProcessing()` / `setTerminalProcessing(v)`
  - `initSession(): Promise<boolean>`（原 `initSingleUser`：从 storage 载入凭证到 state）
  - `startPolling(opts)` / `stopPolling()`
  - `handleMessage(msg, opts)`（slash / contextToken 更新 / 触发 turn）
  - `onAiDone()`
  - `startTyping()` / `stopTyping()`（keepalive）
  - `sendReply(text, maxRetries?)`（原 `sendMessageWithRetry`）/ `sendFile(localPath)`（原 `sendFileToUser`）
  - `getTypingTicket()`
  - `getCurrentRequestId()` / `isRequestProcessed(id)` / `markRequestProcessed(id)` / `cleanupProcessedRequests()`
  - `reset()`
- 私有：`getCredentials()`（state+config 组装，供 outbound adapter 与 `canSend`）、`getCurrentOpts()`、`generateRequestId()`、`extractText` / `isSlashCommand` / `handleSlashCommand`。
- **依赖方向**：`channel/*` 不得 import `../engine/*`（`rg "from \"\.\./engine" src/channel` 必须为空）；
  `channel/router.ts` 的宿主类型改用 `../ports/pi-host.js` 的 `PiHost`。

## WechatEngine 薄门面（`src/engine/wechat.ts`）
- 内部持有 `private channel = new Channel({ ... })`；所有公共方法**委托**给 channel。
- 公共 API/导出**逐成员不变**：`WechatEngine`、`engine`、`createWechatEngine`、`setPi`、`setConfig`、
  `WechatHost`（可 `export type WechatHost = PiHost`）、`WechatConfig`、`ConnectionState`（改从 `../channel/polling.js` re-export）。
- `createWechatEngine(initial?)` 接受 `{ host?, config?, ports? }`，构造 `WechatEngine` 并把 ports 传给 Channel（测试用）。
- 私有 `getCredentials` 可下沉到 Channel；engine 不再直接读 state。

## 集成测试 `tests/integration/channel-flow.test.ts`
**假 pi 宿主（PiHost mock/探针）+ 真 `Channel` + 假端口（fake inbound/outbound/media）+ 真实 storage（临时目录）**：
- 入站文本：`handleMessage(textMsg, opts)` → `host.appendEntry("wechat_meta", {requestId})` + `host.sendUserMessage(content, {deliverAs:"followUp"})`；`onAiDone()` 后队列释放。
- 入站媒体：`handleMessage(mediaOnlyMsg, opts)` → `outbound.sendText("媒体文件已收到，正在保存…")`；后台串行后 `media.download` 被调用且 `host.sendMessage({customType:"wechat_media"}, {triggerTurn:false,...})`。
- typing：`startTyping()` → `outbound.sendTyping(1, ticket)`；`stopTyping()` 停止。
- 出站：`sendReply("hi")` → `outbound.sendText("hi")`；`sendFile(path)` → `outbound.sendFile(path)`。
- `reset()`：清凭证但不影响 config/host/notifier。
（不得用 `mock.module` vendor；本测试走端口注入。）

## test-migration
沿用端口 fake；本阶段把 `tests/engine/{queue,media-store,router}.test.ts` 的 import 改到 `src/channel/*`。

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（121）+ 本阶段新增
- [ ] `src/channel/` 含 `channel.ts` + 移动后的协作类；`rg "from \"\.\./engine" src/channel` 为空
- [ ] `src/engine/` 仅剩 `wechat.ts`（薄门面）；`engine` 不再直接持有协作类/state 逻辑（仅委托）
- [ ] `WechatEngine` 公共 API 逐成员不变；bridge 调用点未改（`src/bridge/*` diff 为空，除可能无）
- [ ] 集成测试 `tests/integration/channel-flow.test.ts` 通过，覆盖入站/媒体/typing/出站
- [ ] vendor 目录零 diff
- [ ] 关键回归语义仍覆盖：D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改 `WechatEngine` 公共 API/行为语义、不得改 `src/bridge/*` 行为
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(channel): 移动协作类到 channel/ 并更新 import`
2. `refactor(channel): 新增 Channel 粗粒度编排器`
3. `refactor(engine): WechatEngine 退化为委托 Channel 的薄门面`
4. `test(channel): 新增通道集成测试`

## report
完成后写 `/tmp/pi-tasks/pa-5.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-5`
