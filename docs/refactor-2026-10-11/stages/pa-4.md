# Task: PA-4 抽取 ChannelState + 修回 sendWithRetry 前置检查

base: dev
branch: refactor/pa-4-channel-state
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 115 pass / 13 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、WechatEngine 公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
把 `WechatEngine` 持有的**运行时会话状态**抽取到 `src/channel/state.ts` 的 `ChannelState`，
让 engine 只保留逻辑与协作类引用；同时**修回 PA-3 verifier 记录的 `sendWithRetry` 前置检查行为差异**。
不改变 `WechatEngine` 的公共 API 与外部行为。

## scope
- prod（新增）：
  - `src/channel/state.ts` → `ChannelState` + `Notifier` 类型
- prod（修改）：
  - `src/engine/wechat.ts`（字段改由 `ChannelState` 承载；公共方法签名/行为不变）
  - `src/engine/sender.ts`（`SenderDeps` 增加 `canSend(): boolean`；`sendWithRetry` 恢复入口前置检查）
- tests：
  - 新增 `tests/unit/channel-state.test.ts`
  - `tests/engine/engine.test.ts`（新增/调整：`sendWithRetry` 缺凭证时**不调用**底层发送、立即抛错、不进入重试）
  - 其余 harness 如因 `SenderDeps.canSend` 需补 fake 则可改

## 设计要求
1. **ChannelState 承载的数据**（原 `WechatEngine` 字段迁移）：
   - 凭证：`accountId: string | null`、`userId: string | null`、`contextToken: string | null`
   - `config: WechatApiOpts | null`（用 `../shared/types` 的 `WechatApiOpts`，避免依赖 engine）
   - `host: PiHost | null`（用 `../ports/pi-host` 的 `PiHost`，**避免 channel → engine 反向依赖**）
   - `notifier: Notifier | null`（`Notifier = (message: string, type?: "info"|"warning"|"error") => void`）
   - `isTerminalMessageProcessing: boolean`
   - 请求追踪：`lastRequestIdMs: number`、`requestIdSeq: number`
   - `resetSession()`：清空凭证 + 终端标志 + 请求追踪（**保留** `config`/`host`/`notifier`，与现 `WechatEngine.reset()` 一致）
2. **保留**协作类为独立类，不并入 ChannelState：`PollingLoop`、`TurnQueue`、`SerialTaskQueue`、`TypingController`、`MessageSender`、`MediaStore`、`MessageRouter`。
   - `syncCursor` 仍留在 `PollingLoop` 内部（本阶段不迁移）。
3. `WechatEngine`：用 `private state = new ChannelState()` 替代原字段；所有读写改走 `state.*`；`setHost/setConfig/setNotifier/configure/getTerminalProcessing/setTerminalProcessing/initSingleUser/handleMessage/...` 的**签名与行为完全不变**。
   - `WechatHost` 仍从 `wechat.ts` 导出（可 `export type WechatHost = PiHost`），以保持 `router.ts` 等既有 import 不变。
4. **sendWithRetry 修回**（对齐 dev 旧行为）：
   - `SenderDeps` 增加 `canSend(): boolean`（由 engine 注入 `() => this.getCredentials() !== null`）
   - `sendWithRetry(text)` 入口先 `if (!this.deps.canSend()) throw new Error("Single user not initialized")`，再进入重试循环
   - 效果：缺凭证时**立即抛错、不重试、不 sleep、不调用 outbound.sendText**（与旧实现一致）

## test-migration
沿用端口 fake（PA-3 已完成）；本阶段新增 `channel-state` 单测与 `sendWithRetry` 前置检查用例。

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（115）+ 本阶段新增
- [ ] 新增 `src/channel/state.ts`；`rg "from \"../engine" src/channel` 为空（无反向依赖）
- [ ] `WechatEngine` 公共 API 逐成员不变（仅内部字段改由 `state` 承载）
- [ ] `resetSession()` 语义与旧 `reset()` 对这些字段的处理一致（凭证/终端/计数清空，config/host/notifier 保留）
- [ ] `sendWithRetry` 缺凭证时立即抛 `"Single user not initialized"`，且 `outbound.sendText` **未被调用**（有测试覆盖）
- [ ] vendor 目录（api/auth/cdn/media/messaging/util/types）零 diff
- [ ] `src/bridge/{events,commands,tool-send-file}.ts` 行为未改
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改 `WechatEngine` 公共 API/行为语义
- 不得把协作类并入 ChannelState（保持独立类）
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(channel): 新增 ChannelState 承载运行时会话状态`
2. `refactor(engine): 字段迁移到 ChannelState（公共 API 不变）`
3. `fix(sender): 恢复 sendWithRetry 缺凭证前置检查`
4. `test: ChannelState 与 sendWithRetry 前置检查`

## report
完成后写 `/tmp/pi-tasks/pa-4.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-4`
