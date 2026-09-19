# 测试说明（pi-wechat-extension）

## 运行

环境使用 Bun（`node` 在本机只是指向 `bun` 的软链，没有 npm）：

```bash
bun test --isolate      # 跑全部（推荐）
bun test --isolate tests/unit    # 只跑纯逻辑层
bun test --isolate tests/engine  # 只跑引擎状态机层
bun test --isolate tests/bridge  # 只跑事件桥接层
```

也可以在项目里执行 `bun run test`（等价于 `bun test --isolate`）。

> **为什么需要 `--isolate`**：`mock.module` 是**进程全局**的，Bun 默认在同一进程按顺序跑各测试文件，
> bridge 文件对 `wechat.js` 的 mock 会泄漏到 engine 文件，导致后者拿到假 engine。
> `--isolate` 让每个测试文件使用全新的 global / 模块注册表，互不污染。

## 约定：证伪 / 目标

- **证伪测试**（普通 `test`）：断言旧代码当前「错误的行为」。它通过，说明缺陷真实存在。
- **目标测试**（`test.failing`）：断言「修复后应得的正确行为」。
  - 现在通过 = 该目标行为目前确实做不到；
  - 修复后它会**翻红**，提示你把 `test.failing` 改成普通 `test` —— 这就是「改完是否可行」的验收开关。

> 注意：`test.failing` 只要测试失败（含导入错误等）就会通过，因此每次新增目标用例后，
> 建议做一次健全性校验：临时把 `test.failing` 改成 `test` 并加 `.only`，确认它是在
> **目标断言处**以 `Expected/Received` 失败，而不是因环境错误失败。

## 分层

| 层 | 目录 | 被测对象 | 手法 |
|---|---|---|---|
| L1 纯逻辑 | `tests/unit` | `config.ts`、`storage/state.ts` | 真实模块 + mock `getAgentDir`/`logger`，临时目录 |
| L2 引擎状态机 | `tests/engine` | `wechat.ts` 的 `WechatEngine` | `mock.module` 掉 api/messaging/media，可控返回值；storage/config 用真实实现 |
| L3 事件桥接 | `tests/bridge` | `index.ts` | 探针型假 `ExtensionAPI` + 假 engine |

## 基础设施

- `tests/setup/mocks.ts`
  - 固定一个临时 `getAgentDir()`，并 mock `@mariozechner/pi-coding-agent`、`@sinclair/typebox`、`util/logger`。
  - 必须在第一次 import 被测源码前调用 `installBaseMocks()`；测试文件用动态 `await import()` 加载源码。
- `tests/setup/fake-pi.ts`
  - `createFakePi()`：记录 `on/registerTool/registerCommand`，可手动触发事件。
  - `createFakeCtx(branch)`：可控 `sessionManager.getBranch()`、`cwd`、`model`、`getContextUsage`。
  - `wechatMetaEntry()` / `plainMessageEntry()` / `assistantMessage()` 等 fixture。

## 用例 ↔ 缺陷对照

| 编号 | 缺陷 | 用例 | 状态 |
|---|---|---|---|
| D1 | 去重命中后 early-return 不调 `onAiDone` → 队列停滞 | `tests/bridge/turn-state.test.ts` | ✅ 证伪 + 目标 |
| D2 | 发送前就 `markRequestProcessed`，失败后不可重试 | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D4 | module 全局 turn 标记 + `setTimeout(20ms)` 竞态导致回复丢弃 | `tests/bridge/turn-state.test.ts` | ✅ 证伪 + 目标 |
| D5 | `isTerminalMessageProcessing` 在 agent_end 缺失时卡死 | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D8-a | `WECHAT_DEBUG=false` 无法覆盖 config.json | `tests/unit/config.test.ts` | ✅ 证伪 + 目标 |
| D8-b | 只设 `WECHAT_MEDIA_PATH` 会连带关闭 debug | `tests/unit/config.test.ts` | ✅ 证伪 + 目标 |
| D8-c | `DEFAULT_CONFIG` 含接口未声明的 `prefix` | `tests/unit/config.test.ts` | ✅ 证伪 + 目标 |
| D10 | `getSingleUserContextToken` 取第一个 key，不绑 `token.userId` | `tests/unit/storage.test.ts` | ✅ 证伪 + 目标 |
| D12 | 存储 read-modify-write 并发丢写（非原子） | `tests/unit/storage.test.ts` | ✅ 证伪 + 目标 |
| D3 | `startPolling` 可重入（并发轮询） | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D6 | `sendUserMessage` 同步抛错被当轮询失败 | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D7 | `safelyTriggerNext` 未 await/catch 排空时的 rejection | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D9 | `stopPolling` 不取消在途长轮询、不 await | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标（依赖 `getUpdates` 是否收 signal） |
| D11 | 明文打印 `botToken` | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D13 | 同毫秒 requestId 冲突 | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D14 | `sendFileToUser` 忽略 `fileName` | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D15 | `isSlashCommand` 魔法数字 + 只看首条 | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D16 | typing ticket 不随 contextToken 失效、interval 未 unref | `tests/engine/engine.test.ts` | ✅ 证伪 + 目标 |
| D17 | 只监听 `agent_end`，未用 `agent_settled`（pi 会重试/压缩/续跑） | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D18 | `message_start/end` 对所有角色触发，typing 过早关闭 | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D19 | `setFooter` 覆盖内置 footer | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D20 | `/wechat start` 未 `setConfig` | `tests/bridge/event-wiring.test.ts` | ✅ 证伪 + 目标 |
| D21 | `buildMetaInfo` 每轮全量扫描分支（性能） | —（未覆盖） | ⏳ 性能观察，暂无可验证目标 |
| D22 | 依赖清单与 import 不一致（typebox 未声明） | `tests/unit/dependencies.test.ts` | ✅ 证伪 + 目标 |

## 已知前置 / 风险

- 仓库 import 的是 `@mariozechner/pi-coding-agent`，本机安装的 pi 是 `@earendil-works/...`。
  测试期统一 mock 掉，规避该 scope 不一致；后续需要确认运行时到底用哪个包。
- D9 能否真正取消在途长轮询，取决于底层 `getUpdates` 是否接受 `AbortSignal`。按约定不读/不改底层模块，
  先用目标用例占位，确认接口后再决定。
- `config.ts` / `storage/state.ts` 的路径常量在 import 时求值，所以 `getAgentDir()` 在测试进程内固定为同一临时目录，
  用例间通过清空目录内容实现隔离，而不是切换目录。
