# 测试说明（pi-wechat-extension）

> **状态：修复阶段已完成（Wave 1–3）。** 全套 `bun run test` 通过，仓库内已无 `test.failing`：
> 原先断言的「证伪」用例已随修复删除，所有「目标」用例已晋升为普通 `test`。
> 本文档保留证伪/目标方法论，作为后续新缺陷的回归流程参考。

## 架构重构回归（R1–R6）

2026-09 的架构重构在不改变外部行为的前提下拆分了 `wechat.ts`；整套测试在每个阶段保持全绿：

| 阶段 | 内容 | 新增/受影响测试 |
|---|---|---|
| R1 | 去模块全局，注入 `WechatHost`/config + `createWechatEngine()` | `engine.test.ts` 隔离实例用例 |
| R2 | 提取 `PollingLoop` + B4 `needs_relogin` 通知 | `engine.test.ts` B4 用例 |
| R3 | 提取 `TurnQueue` + B6 关联性 | `queue.test.ts`、`engine.test.ts` 连发排空用例 |
| R4 | 提取 `MediaStore` + B5 后台串行媒体 | `media-store.test.ts`、`engine.test.ts` 非阻塞/串行用例 |
| R5 | 提取 `TypingController` / `MessageSender` | 复用既有 D14/D16/D16b 用例 |
| R6 | 统一 `logger.ts` + 脱敏（B7） | `tests/unit/logger.test.ts` |

迁移注意：engine 内部字段（如 `typingTicketCache`、`pendingMessages`）已移入协作类，测试统一走 engine 公共方法；
`tests/engine/queue.test.ts` / `media-store.test.ts` 直接对纯模块做单测。

## 运行

环境使用 Bun（`node` 在本机只是指向 `bun` 的软链，没有 npm）：

```bash
bun run test                     # 跑全部（等价 bun test --isolate）
bun test --isolate tests/unit    # 只跑纯逻辑层
bun test --isolate tests/engine  # 只跑引擎状态机层
bun test --isolate tests/bridge  # 只跑事件桥接层
bun run typecheck                # tsc --noEmit（底层模块有 3 条既有 TS2307 例外，见文末）
```

> **为什么需要 `--isolate`**：`mock.module` 是**进程全局**的，Bun 默认在同一进程按顺序跑各测试文件，
> bridge 文件对 `wechat.js` 的 mock 会泄漏到 engine 文件，导致后者拿到假 engine。
> `--isolate` 让每个测试文件使用全新的 global / 模块注册表，互不污染。

## 方法论：证伪 / 目标（新增缺陷时使用）

- **证伪测试**（普通 `test`）：断言旧代码当前「错误的行为」。它通过，说明缺陷真实存在。
- **目标测试**（`test.failing`）：断言「修复后应得的正确行为」，修复后会翻红提示晋升为普通 `test`。
- 注意：`test.failing` 只要测试失败（含导入错误等）就会通过，因此每次新增目标用例后，
  建议临时把 `test.failing` 改成 `test` + `.only`，确认它是在**目标断言处**以 `Expected/Received` 失败。

## 分层

| 层 | 目录 | 被测对象 | 手法 |
|---|---|---|---|
| L1 纯逻辑 | `tests/unit` | `config.ts`、`storage/state.ts` | 真实模块 + mock `getAgentDir`/`logger`，临时目录 |
| L2 引擎状态机 | `tests/engine` | `wechat.ts` 的 `WechatEngine` | `mock.module` 掉 api/messaging/media，可控返回值；storage/config 用真实实现 |
| L3 事件桥接 | `tests/bridge` | `index.ts` | 探针型假 `ExtensionAPI` + 假 engine |

## 基础设施

- `tests/setup/mocks.ts`
  - 固定一个临时 `getAgentDir()`，并 mock `@earendil-works/pi-coding-agent`、`@sinclair/typebox`、`util/logger`。
  - 必须在第一次 import 被测源码前调用 `installBaseMocks()`；测试文件用动态 `await import()` 加载源码。
- `tests/setup/engine-harness.ts`：mock 底层 `api/api`、`api/types`、`messaging/send(-media)`、`media/media-download`。
- `tests/setup/bridge-harness.ts`：假 engine（带去重语义）+ 可控 auth mock + `setConfig` 探针。
- `tests/setup/fake-pi.ts`：`createFakePi()` / `createFakeCtx()` 与各类 fixture。

## 用例 ↔ 缺陷对照（均已修复）

| 编号 | 缺陷 | 用例 | 修复要点 |
|---|---|---|---|
| D1 | 去重命中后 early-return 不调 `onAiDone` → 队列停滞 | `tests/bridge/turn-state.test.ts` | 所有路径 `finally { onAiDone() }` |
| D2 | 发送前就 `markRequestProcessed`，失败后不可重试 | `tests/bridge/event-wiring.test.ts` | 发送成功后再标记 |
| D3 | `startPolling` 可重入（并发轮询） | `tests/engine/engine.test.ts` | 单飞行守卫 + generation 令牌 |
| D4 | module 全局 turn 标记 + `setTimeout(20ms)` 竞态 | `tests/bridge/turn-state.test.ts` | 每轮同步解析并显式传参 |
| D5 | `isTerminalMessageProcessing` 在 agent_end 缺失时卡死 | `tests/bridge/event-wiring.test.ts` | `agent_settled` 兜底释放 |
| D6 | `sendUserMessage` 同步抛错被当轮询失败 | `tests/engine/engine.test.ts` | try/catch/finally 释放状态 |
| D7 | `safelyTriggerNext` 未 await/catch 排空 rejection | `tests/engine/engine.test.ts` | await + catch，去掉字符串匹配 |
| D8-a/b/c | 配置优先级 bug、`prefix` 字段 | `tests/unit/config.test.ts` | 环境变量按字段独立覆盖；删除 `prefix` |
| D9 | `stopPolling` 无法及时取消在途长轮询 | `tests/engine/engine.test.ts` | 底层无 `AbortSignal`，改用 abort-race，循环迅速退出（限制见文末） |
| D10 | `getSingleUserContextToken` 不绑 `token.userId` | `tests/unit/storage.test.ts` | 按 `token.userId` 精确取 |
| D11 | 明文打印 `botToken` | `tests/bridge/event-wiring.test.ts` | 使用 `util/redact` 脱敏 |
| D12 | 存储 read-modify-write 并发丢写（非原子） | `tests/unit/storage.test.ts` | 原子写 + 按路径串行队列 |
| D13 | 同毫秒 requestId 冲突 | `tests/engine/engine.test.ts` | 时间戳 + 同毫秒递增序号 |
| D14 | `sendFileToUser` 忽略 `fileName` | `tests/engine/engine.test.ts` | 底层不支持显示名，移除该参数，以 basename 为准 |
| D15 | `isSlashCommand` 魔法数字 + 只看首条 | `tests/engine/engine.test.ts` | 用 `MessageItemType.TEXT` 并遍历 |
| D16 | typing ticket 不随 contextToken 失效、interval 未 unref | `tests/engine/engine.test.ts` | 缓存按 token 命中；interval `unref` |
| D17 | 只监听 `agent_end`，未用 `agent_settled` | `tests/bridge/event-wiring.test.ts` | 最终回复改在 `agent_settled` 发送 |
| D18 | `message_start/end` 对所有角色触发，typing 过早关闭 | `tests/bridge/event-wiring.test.ts` | 仅 assistant 控制 typing |
| D19 | `setFooter` 覆盖内置 footer | `tests/bridge/event-wiring.test.ts` | 改用 `pi.exec("git", …)` 取分支 |
| D20 | `/wechat start` 未 `setConfig` | `tests/bridge/event-wiring.test.ts` | start 内部设置配置 |
| D21 | `buildMetaInfo` 每轮全量扫描分支（性能） | `tests/bridge/event-wiring.test.ts` | 增量累计 cost |
| D22 | 依赖清单与 import 不一致（typebox 未声明） | `tests/unit/dependencies.test.ts` | 声明 `@sinclair/typebox` |

## 已知限制 / 例外

- **D9**：底层 `api/api.ts` 的 `getUpdates` 不接受 `AbortSignal`。修复采用核心层 `Promise.race`
  让轮询循环在 `stopPolling` 后迅速退出；在途 HTTP 仍会在后台直到自身超时。若将来底层支持 signal，可进一步真取消。
- **D14**：底层 `messaging/send-media.ts` 的 `sendWeixinMediaFile` 无自定义显示名参数，
  故移除了工具/引擎层的 `fileName`；微信显示名以本地文件 basename 为准。
- **typecheck 例外**（均位于白名单外的底层模块，属既有问题）：
  - `media/silk-transcode.ts` → `silk-wasm`（可选依赖，缺失时降级）
  - `messaging/inbound.ts` → `../storage/state-dir.js`（文件已删除，仅 type-only 引用）
  - `messaging/send.ts` → `openclaw/plugin-sdk/reply-runtime`（type-only 私有包）
- `config.ts` / `storage/state.ts` 的路径常量在 import 时求值，`getAgentDir()` 在测试进程内固定为同一临时目录，
  用例间通过清空目录内容实现隔离。

## 包作用域

核心代码与测试 mock 统一使用 `@earendil-works/pi-coding-agent`（跟随本机 pi 0.85.x）；
`package.json` 的 devDependency 已同步。底层模块不引用该 SDK。
