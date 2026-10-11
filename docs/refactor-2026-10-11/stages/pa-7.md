# Task: PA-7 删除 WechatEngine 门面与 src/engine/ 并把 engine 测试迁移到 channel

base: dev
branch: refactor/pa-7-remove-engine
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 127 pass / 15 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公开行为、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
删除已无用途的 `WechatEngine` 薄门面与整个 `src/engine/`，把 L2 测试从「测 WechatEngine」
迁移为「直接测 `Channel`」，**保留全部回归用例（D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9）**。

## scope
- prod（删除）：
  - `src/engine/wechat.ts`（以及空的 `src/engine/` 目录）
- prod（清理注释/字符串引用，不改行为）：
  - `src/channel/{router,state,channel}.ts`、`src/ports/pi-host.ts` 中提及 `WechatEngine`/`WechatHost` 的**注释**
  - `src/channel/router.ts` 的运行时错误字符串 `"WechatHost not configured"`：**如无测试断言则保留原样**（避免行为变化）；仅改注释
- tests（迁移/重命名）：
  - `tests/engine/engine.test.ts` → `tests/channel/channel.test.ts`（直接测 `Channel`）
  - `tests/engine/media-store.test.ts` → `tests/channel/media-store.test.ts`
  - `tests/engine/queue.test.ts` → `tests/channel/queue.test.ts`
  - `tests/engine/router.test.ts` → `tests/channel/router.test.ts`
  - `tests/setup/engine-harness.ts` → `tests/setup/channel-harness.ts`（`importEngine`→`importChannel`；`createWechatEngine(...)`→`new Channel(...)`）
  - `tests/unit/dependencies.test.ts`：`CORE_FILES` 中 `src/engine/wechat.ts` → `src/channel/channel.ts`
  - `tests/README.md`：把 `tests/engine`、`src/engine/wechat.ts` 等旧路径更新为 `tests/channel`、`src/channel/*`

## 测试迁移映射（保持断言语义）
| 旧（WechatEngine） | 新（Channel） |
|---|---|
| `createWechatEngine({host,config,ports})` | `new Channel({ host, config, ports })`（或 harness 的 `createChannel`） |
| `initSingleUser()` | `initSession()` |
| `startTypingKeepalive()` / `stopTypingKeepalive()` | `startTyping()` / `stopTyping()` |
| `sendMessageWithRetry(text)` | `sendReply(text)` |
| `sendFileToUser(path)` | `sendFile(path)` |
| `(engine as any).channel.state/queue/router` | `(channel as any).state/queue/router` |
| 其余 `setHost/setConfig/setNotifier/configure/connectionState/getTerminalProcessing/setTerminalProcessing/startPolling/stopPolling/handleMessage/triggerAi/onAiDone/getTypingTicket/isRequestProcessed/markRequestProcessed/cleanupProcessedRequests/reset` | 同名 |

- 迁移后必须仍覆盖：**D3**（重入守卫）、**D6**（sendUserMessage 抛错释放）、**D7**（drain catch）、**D9**（stopPolling 快速退出）、**D13**（同毫秒 requestId）、**D14**（sendFile basename/单参）、**D15**（slash）、**D16×3**（ticket 缓存/失效/清缓存）、**D16b**（unref）、**B4**（needs_relogin）、**B5×2**（媒体立即 ack + 后台串行）、**B6**（排队一一对应）、**C9**（实例隔离——改为「两个 `Channel` 实例互不污染」）。
- `tests/integration/channel-flow.test.ts`、`tests/unit/channel-state.test.ts` 不变。

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（127）
- [ ] `test -d src/engine` 为假；`rg "src/engine|engine/wechat" src tests` 为空
- [ ] `rg "\bWechatEngine\b|createWechatEngine" src tests` 为空（注释也已清理）
- [ ] `tests/channel/` 含 channel/media-store/queue/router 测试；`tests/setup/channel-harness.ts` 存在，`tests/setup/engine-harness.ts` 不存在
- [ ] `tests/unit/dependencies.test.ts` 的 `CORE_FILES` 指向 `src/channel/channel.ts` 并通过
- [ ] 全部回归用例（D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9）仍在且通过
- [ ] vendor 目录零 diff
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改变 `Channel`/bridge 的运行时行为（仅删无用门面、迁移测试）
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(channel): 删除 WechatEngine 门面与 src/engine/`
2. `test(channel): 将 engine 测试迁移到 tests/channel 并保留回归用例`
3. `chore(test): 更新 dependencies CORE_FILES 与 tests/README 路径`

## report
完成后写 `/tmp/pi-tasks/pa-7.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-7`
