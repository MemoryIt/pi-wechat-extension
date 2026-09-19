# 架构说明（pi-wechat-extension）

面向维护者。使用说明见 [`../README.md`](../README.md)。

## 1. 设计目标

- 单用户模式：一个微信账号、一个主会话，避免多用户 Map 与 userId 解析。
- 事件驱动、无跨轮可变标记：每轮 turn 的身份在事件发生时同步从 session 分支解析。
- 层内高内聚、边界清晰：`engine` 不感知 pi 事件，`bridge` 不直连微信 HTTP，适配层不反向依赖自写层。
- 依赖注入优先：引擎依赖窄接口（`WechatHost`）而非 `ExtensionAPI`，便于隔离单测。

## 2. 分层与依赖方向

```
index.ts (组合根)
   ├──→ bridge/*    （pi.on 事件、命令、工具）
   ├──→ engine/*    （轮询、队列、路由、发送、typing、媒体）
   └──→ storage/*

bridge ──→ engine ──→ shared
   └────────┴──────────┴──→ storage
所有自写层 ──→ 适配层 (api / auth / cdn / media / messaging / util)
```

- **禁止反向依赖**：`engine` / `shared` 不得 import `bridge`；`storage` 不得 import `engine`。
- **适配层边界**：`api/ auth/ cdn/ media/ messaging/ util/` 迁移自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，视为第三方；自写层只调用其公开函数，不修改其内部实现。
- `engine/router.ts` 通过依赖窄接口（`queue` / `mediaStore` / `mediaQueue` / `sender` / `getHost` / `getOpts` / `logger`）工作，不直接持有 `WechatEngine`，因此可独立单测。
- `engine/polling.ts` 通过 `PollingLoopDeps` 反向注入宿主能力（会话、cursor、消息处理、通知、日志、sleep），自身不依赖 `storage`。

## 3. 自写模块职责与关键导出

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/index.ts` | 组合根：把工具/命令/桥接装配到 `ExtensionAPI` | `default(pi)` |
| `src/engine/wechat.ts` | 引擎门面（单用户）：状态、凭证、队列排空、对 pi 宿主适配、工厂与单例 | `WechatEngine`、`engine`、`createWechatEngine`、`setPi`、`setConfig`、`WechatHost`、`WechatConfig`、`ConnectionState` |
| `src/engine/polling.ts` | 长轮询循环 / 退避 / abort-race / 重入守卫 / generation 令牌 / 连接状态 | `PollingLoop`、`PollingLoopDeps`、`POLL_ABORTED`、`ConnectionState`、`DEFAULT_LONG_POLL_TIMEOUT_MS` |
| `src/engine/queue.ts` | 轮次队列纯状态：FIFO、忙闲、当前 requestId、去重与清理；后台串行任务队列 | `TurnQueue`、`SerialTaskQueue` |
| `src/engine/router.ts` | turn 执行（文本注入 / 媒体后台）+ 队列排空 | `MessageRouter`、`RouterDeps` |
| `src/engine/media-store.ts` | 媒体落盘、ISO 周目录、魔数/MIME 识别、批量下载 | `MediaStore`、`detectFileType`、`CONTENT_TYPE_EXT_MAP`、`getISOWeek`、`getCurrentWeekFolder` |
| `src/engine/typing.ts` | typing ticket 缓存 + keepalive | `TypingController`、`TypingCredentials` |
| `src/engine/sender.ts` | 文本/文件出站发送 + 重试 | `MessageSender` |
| `src/bridge/events.ts` | 注册全部 `pi.on`，`agent_settled` 发送最终回复 | `registerBridge` |
| `src/bridge/turn.ts` | turn 身份解析（近纯函数）+ `input` FIFO | `resolveTurnBeforeRun`、`resolveTurnFromBranch`、`extractLastReply`、`isAssistantMessage`、`pushPendingWechatInput`、`WechatTurn` |
| `src/bridge/meta.ts` | Git 分支缓存 + 运行信息（成本增量累计） | `buildMetaInfo`、`refreshCachedGitBranch`、`getCachedGitBranch` |
| `src/bridge/commands.ts` | `/wechat` 命令注册 | `registerCommands` |
| `src/bridge/tool-send-file.ts` | `send_wechat_file` 工具定义 | `createSendFileTool` |
| `src/bridge/login.ts` | 扫码登录流程与凭证落盘 | `performWechatLogin` |
| `src/shared/config.ts` | 配置加载（文件 + 环境变量，按字段覆盖） | `loadConfig`、`isDebugEnabled`、`getMediaStoragePath`、`clearConfigCache` |
| `src/shared/logger.ts` | 统一控制台日志 + 脱敏 | `createLogger`、`PluginLogger`、`redactToken`、`redactBody`、`redactUrl` |
| `src/shared/time.ts` | 统一时间戳（`YYMMDDHHMMSSmmm`） | `formatTimestamp` |
| `src/storage/state.ts` | 凭证/账号/context token/sync cursor 持久化；原子写 + 单用户便捷函数 | `saveToken`、`getDefaultAccountToken`、`getSingleUserCredentials`、`getSingleUserContextToken`、`saveContextToken`、`saveSyncCursor` |
| `src/storage/state-dir.ts` | 状态目录解析 | `resolveStateDir` |

## 4. 关键机制

### 4.1 turn 识别与 `agent_settled` 发送

- 微信文本 turn 在 `router.execute()` 中先 `host.appendEntry("wechat_meta", { requestId })`，再 `host.sendUserMessage(content, { deliverAs: "followUp" })`。
- 每轮身份不做跨轮存储：
  - `input` 事件把注入文本按 FIFO 入队（`pushPendingWechatInput`）。
  - `before_agent_start` 用 `resolveTurnBeforeRun()`：从分支叶子向前找 `wechat_meta`，若先遇到 assistant 则为终端 turn；找不到时用 `event.prompt` 与 FIFO 兜底。
  - 运行中/结束后用 `resolveTurnFromBranch()`：以最后一条 user 消息的 `parentId` 反查 `wechat_meta`。
- 最终回复在 **`agent_settled`** 发送（一轮只发一次，覆盖重试/压缩/续跑后的最终版）；`agent_end` 只负责 typing 收敛与终端标志兜底。
- 发送成功后才 `markRequestProcessed(requestId)`；失败可重试（D2）。所有路径 `finally` 调 `onAiDone()` 释放队列（D1）。
- `message_start`/`message_end` **仅对 assistant 消息**控制 typing（D18）。

### 4.2 轮询：重入守卫 / generation / abort-race

- `pollingActive` 单飞行守卫：已有会话在跑则 `start()` 直接返回，杜绝并发轮询（D3）。
- `pollingGeneration` 令牌：`reset()`/新会话令旧令牌过期，旧循环拿到过期结果后丢弃，不污染新状态。
- 底层 `getUpdates` 不接受 `AbortSignal`（D9）：用 `createAbortWaiter()` 构造 reject(`POLL_ABORTED`) 的 promise 与请求 `Promise.race`；`stop()` 触发 abort 使循环迅速退出，在途 HTTP 后台自行超时。
- 会话过期（`errcode/code === -14`）→ `connectionState = "needs_relogin"`，触发 `onNeedsRelogin()`；`finally` 不覆盖该终态（B4）。

### 4.3 `TurnQueue` 与 requestId 唯一性

- `TurnQueue<T>`：`pending` FIFO、`busy`（等价旧 `isAiProcessing`）、`currentRequestId`、`processed: Map<id, ts>`。
- `markRequestProcessed` 每 50 次触发一次清理（删除 1 小时前的记录）。
- requestId = `formatTimestamp()`（15 位）+ 3 位同毫秒序号，保证同毫秒内唯一（D13）。
- `SerialTaskQueue` 用 promise 链保证后台任务串行；单个任务抛错经 `onError` 上报且不阻断后续。

### 4.4 媒体后台串行（B5）

- 纯媒体消息（有媒体、无文本）：立即回执「媒体文件已收到，正在保存…」，然后 `mediaQueue.enqueue(processMediaInBackground)`。
- `MediaStore.downloadAll()` 逐个调用 `downloadMediaFromItem`，单项失败仅记录并继续；成功后通过 `host.sendMessage({ customType: "wechat_media", ... }, { triggerTurn: false, deliverAs: "followUp" })` 把路径写入会话历史（不触发新 turn）。
- 落盘路径：`{mediaStoragePath}/{YY}{WW}/{YYMMDDHHMMSSmmm}_{uuid8}.{ext}`，扩展名优先级为原文件名后缀 > contentType > 魔数 > `bin`。

### 4.5 Typing keepalive

- `TypingController` 从 `getConfig` 取 `typing_ticket`，缓存 TTL 60s 且**绑定 contextToken**（token 变化立即失效，D16）。
- `startKeepalive()` 先发 `typing=1`，再 `setInterval(8000ms)` 刷新；定时器 `unref()`，不阻止进程退出。
- `message_end`/`agent_end`/`agent_settled` 停止 keepalive；发送失败且错误含 "ticket" 时清缓存。

### 4.6 日志与脱敏

- 全仓库统一走 `createLogger()`（仅 console，不接文件日志）；`wechat.ts` 无 `console.*`（用户可见的 QR/登录输出除外）。
- `debug` 仅在 `isDebugEnabled()` 为真时输出，**每次调用求值**，支持测试动态开关。
- `sanitize()`：`Error` 只取 `message`（不带 stack）；字符串/对象先 `redactBody` 脱敏（token、context_token 等敏感 JSON 键）再打印；不可序列化对象退化为 `String`，保证日志自身不抛错（B7）。

### 4.7 依赖注入

- `WechatHost` 是 `ExtensionAPI` 的窄接口（仅 `appendEntry` / `sendUserMessage` / `sendMessage`）；`setPi()` 负责适配，测试无需实现整个 `ExtensionAPI`（R1）。
- `createWechatEngine(initial?)` 创建不共享模块单例的独立实例；`configure()` 支持字段级覆盖，便于测试隔离。
- `setNotifier()` 注入 UI 通知（`needs_relogin` / 发送失败）。

### 4.8 存储健壮性

- **原子写**：先写同目录临时文件再 `renameSync` 覆盖，目标文件要么旧内容要么完整新内容（D12）。
- **按路径串行队列**：同一路径的读-改-写按调用顺序执行，避免并发丢写；不同路径互不阻塞。
- `token.json` 以 `chmod 600` 写入。
- `getSingleUserContextToken()` 按 `token.userId` 精确读取（D10），不取 `context-tokens.json` 的第一个 key。

## 5. 与 openclaw-weixin 迁移模块的依赖关系

`api/ auth/ cdn/ media/ messaging/ util/` 迁移自 Tencent/openclaw-weixin，视为**外部适配层**；自写代码只调用以下函数（不展开其内部实现）：

| 自写调用点 | 迁移模块 | 调用面 |
|------------|----------|--------|
| `engine/polling.ts` | `api/api.ts` | `getUpdates` |
| `engine/typing.ts` | `api/api.ts` | `getConfig`、`sendTyping` |
| `engine/sender.ts` | `api/api.ts` | 类型 `WeixinApiOptions` |
| `engine/sender.ts` | `messaging/send.ts` | `sendMessageWeixin` |
| `engine/sender.ts` | `messaging/send-media.ts` | `sendWeixinMediaFile` |
| `engine/media-store.ts` | `media/media-download.ts` | `downloadMediaFromItem` |
| `bridge/login.ts` | `auth/login-qr.ts` | `startWeixinLoginWithQr`、`waitForWeixinLogin`、`DEFAULT_ILINK_BOT_TYPE` |
| `engine/* / bridge/*` | `api/types.ts` | `WeixinMessage`、`MessageItem`、`MessageItemType` |
| `shared/logger.ts` | `util/redact.ts` | `redactToken`、`redactBody`、`redactUrl` |
| `bridge/login.ts` | `util/redact.ts` | `redactToken` |
| `storage/state.ts` | `util/logger.ts` | `logger`（存储层文件日志） |

> `cdn/`、`messaging/inbound.ts`、`messaging/markdown-filter.ts`、`media/silk-transcode.ts`、`media/mime.ts`、`util/random.ts` 等文件仍存在，但**当前自写路径未直接调用**；删除或替换适配层前需评估其被调用面。

## 6. 数据与持久化布局

```
~/.pi/agent/wechat/
├── accounts.json                  # 账号索引 [{ accountId, displayName, loginAt }]
├── config.json                    # 插件配置 { debug, mediaStoragePath }
└── accounts/
    └── {accountId}/
        ├── token.json             # 登录凭证 (chmod 600)
        ├── context-tokens.json    # { [userId]: { displayName, contextToken, lastMessageAt } }
        └── sync.json              # { syncCursor, lastSyncAt }
```

媒体目录（默认 `~/.pi/agent/wechat/media`，可被 `mediaStoragePath` / `WECHAT_MEDIA_PATH` 覆盖）：

```
{mediaStoragePath}/{YY}{WW}/{YYMMDDHHMMSSmmm}_{uuid8}.{ext}
```

## 7. 开发与测试

### 7.1 运行时与工具链

- **运行时（生产）**：插件随 pi 运行在 **Node.js ≥ 22**（pi 自身 `engines.node >= 22.19.0`）。插件只使用标准 Node API（`node:fs`、`node:path`、`node:crypto` 等），**无 Bun 专有依赖**。
- **开发/测试工具链**：使用 **Bun**。
  - `bun run test`（= `bun test --isolate`）：`--isolate` 让每个测试文件使用独立的 global / 模块注册表，避免 `mock.module` 跨文件泄漏。
  - 分层运行：`bun test --isolate tests/unit`、`tests/engine`、`tests/bridge`。
  - `bun run typecheck`：`tsc --noEmit`（底层迁移模块有 3 条既有 TS2307 例外，见 `tests/README.md`）。
- **CI**：Forgejo Actions（`.forgejo/workflows/ci.yml`）在 push / PR 时执行 `bun install --frozen-lockfile` → `bun run test` → `bun run typecheck`。

### 7.2 项目结构

```
├── src/
│   ├── index.ts          # 组合根：注册工具、命令、事件桥接
│   ├── engine/           # 引擎层：wechat(门面) / polling / queue / media-store / typing / sender / router
│   ├── bridge/           # pi 事件桥接：events / turn / meta / commands / tool-send-file / login
│   ├── shared/           # 基础模块：config / logger / time
│   └── storage/          # 持久化：state / state-dir
├── api/ auth/ cdn/ media/ messaging/ util/   # 迁移自 openclaw-weixin（边界与调用面见第 5 节）
├── tests/                # 缺陷回归测试 + 分层夹具（unit / engine / bridge / setup）
├── .forgejo/workflows/   # CI
└── package.json          # scripts: test / typecheck；engines.node >= 22
```

### 7.3 测试分层

| 层 | 目录 | 被测对象 |
|----|------|----------|
| L1 纯逻辑 | `tests/unit` | `shared/config`、`storage/state`、`logger`、依赖清单 |
| L2 引擎状态机 | `tests/engine` | `WechatEngine`、`queue`、`media-store`、`router` |
| L3 事件桥接 | `tests/bridge` | `index` 的事件接线、`turn`、`meta` |

回归用例与 D1–D22 缺陷对照见 [`tests/README.md`](../tests/README.md)。迁移模块的边界与调用面见第 5 节；自写层只调用其公开函数，不修改其内部实现。

## 8. 扩展与维护指引

- **新增 pi 事件/命令/工具** → `src/bridge/`（保持薄，只做事件解析与委托）。
- **轮询/队列/发送/typing/媒体等引擎能力变更** → `src/engine/` 对应协作类；不要把适配层（HTTP/上传/解密）逻辑写进 engine。
- **配置/日志/时间等通用能力** → `src/shared/`。
- **凭证、cursor、context token 等持久化** → `src/storage/`；新增写操作请复用 `writeJsonAtomic` + `withPathQueue`。
- **不要绕过 `WechatHost` 窄接口**：新增 pi 依赖时扩展 `WechatHost` 与 `setPi()`，保持测试可注入。
- 开发/测试流程与分层见第 7 节；提交前保持 `bun run test` 与 `bun run typecheck` 通过。
