# Task: RF-4 修 A3 —— startPolling 同步进入 connecting

base: dev
branch: refactor/rf-4-connecting
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 158 pass / 18 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；连接状态唯一真相源仍在 PollingLoop；公共 API / 文案 / 持久化不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 背景（A3 现象）
重启 pi 后 `/wechat status` 会先显示未连接（`disconnected`），但实际收发正常。
根因：`PollingLoop.start()` 启动轮询后，`connectionState` 要等第一次 `getUpdates` 成功返回
（长轮询最长约 35s）才从 `disconnected` 变 `connected`。
`ConnectionState` 类型里**已定义但从未使用**的 `"connecting"` 就是为这个窗口准备的。

## goal
让 `PollingLoop.start()` 在启动时**同步**进入 `"connecting"`，首次 `getUpdates` 成功后转 `"connected"`。
`/wechat status` 在该窗口显示「connecting」而非「disconnected」。不引入 `SessionService.phase`，
连接状态唯一真相源仍是 `PollingLoop`。

## scope
- prod（修改）：
  - `src/channel/polling.ts`：在 `start()` 的重入守卫之后、`ensureSession()` 之前，
    同步设置 `this.state.connectionState = "connecting"`。其余逻辑不变。
- tests（修改）：
  - `tests/channel/channel.test.ts`：新增 A3 用例（见 test-plan）。

## 行为契约（必须逐条满足）
- `start()` 未被重入守卫拦截时，调用后**同步**为 `"connecting"`（在 `await ensureSession()` 之前）。
- 首次 `getUpdates` 成功返回 → `"connected"`。
- `ensureSession()` 返回 false（无凭证）→ 循环退出后为 `"disconnected"`（**不得卡在 connecting**）。
- `stop()` / `reset()` → `"disconnected"`（现状保持）。
- 会话过期（`errcode/code === -14`）→ `"needs_relogin"`（终态不被覆盖，现状保持）。
- 重入（`pollingActive === true`）→ 直接返回，**不改变**当前状态。
- `Channel.connectionState` getter 仍委托 `poller.connectionState`；`/wechat status`
  文案 `Connection: ${channel.connectionState}` 不变，窗口期显示 `connecting`。

## test-plan
在 `tests/channel/channel.test.ts` 新增：
- [ ] `A3 目标：startPolling 后、首次 getUpdates 返回前 connectionState === "connecting"`
  - seed 单用户 → `inboundMock.getUpdates` 用一个手动 resolve 的 promise（首次调用挂起）
  - `const p = channel.startPolling(opts)` 后**立即**断言 `channel.connectionState === "connecting"`
  - resolve 首次结果 `{ messages: [], cursor: "" }` → `waitFor(() => channel.connectionState === "connected")`
  - `channel.stopPolling()`，等 `p` 结束 → 断言回到 `"disconnected"`
- [ ] 可选：`ensureSession` 无凭证（未 seed）时，`startPolling` 结束后为 `"disconnected"`（不卡 connecting）
- [ ] 既有 D3/D9、`needs_relogin` 等用例保持通过、断言不削弱

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 158
- [ ] `src/channel/polling.ts` 的 `start()` 在 `ensureSession()` 前同步置 `connecting`
- [ ] 新增 A3 用例通过
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/polling.ts` 与 `tests/channel/channel.test.ts`
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/application/**`、`src/bridge/**`、`src/ports/**`、`src/adapters/**`、
  `src/channel/` 下 polling.ts 以外的文件
- 不得引入 `SessionService.phase` 或第二份连接状态
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言

## report
完成后写 `/tmp/pi-tasks/rf-4.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-4`
