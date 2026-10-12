# 架构说明（pi-wechat-extension）

面向维护者。使用说明见 [`../README.md`](../README.md)。

> 本文档描述 2026-10 重构后的 **Ports & Adapters（六边形）/ 薄通道 + application 用例层**结构：
> 旧的引擎门面目录、门面类与其工厂，以及模块级 `setPi`/`setConfig` 均已删除；
> 用例与发送决策收拢到 `src/application/`，pi 事件翻译由 `src/bridge/` 承担，
> 通道核心为 `src/channel/` 的 `Channel` 与显式端口。

## 1. 设计目标

- **单用户模式**：一个微信账号、一个主会话与一个 `Channel` 实例，避免多用户 Map 与 userId 解析。
- **事件驱动、无跨轮可变标记**：每轮 turn 的身份在事件发生时同步从 session 分支解析，不保存跨轮全局状态。
- **端口隔离**：通道核心只依赖 `src/ports/` 定义的窄接口，不感知 pi 事件，也不直接接触微信 HTTP；测试注入 fake 端口即可隔离。
- **用例层与事件翻译分离**：`src/application/` 承载用例（`SessionService` 会话生命周期、`ReplyService` 回复发送决策），`bridge` 只做 pi 事件的翻译与委托；application 依赖自身 DTO/窄接口、`storage` 与 `ports`，不感知 pi / vendor / 具体 `Channel`。
- **适配器唯一接触 vendor**：所有对迁移自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的 `api/ auth/ cdn/ media/ messaging/ util/` 的调用都收敛在 `src/adapters/`（及两个再导出边界）。
- **显式组合根**：`src/index.ts` 的 `createExtension(deps?)` 显式组装 `PiHost + Channel + WechatAuth`，不依赖模块级单例。
- **纯协作类可单测**：`queue` / `media-store` / `router` / `typing` / `sender` / `polling` 通过依赖注入的窄接口工作，可脱离 `Channel` 独立单测。

## 2. 分层与依赖方向

```
src/index.ts (组合根 createExtension)
   ├──→ bridge/*         pi.on 事件、命令、工具（事件翻译，委托 application 用例）
   ├──→ application/*    SessionService / ReplyService + 窄接口与 DTO
   ├──→ channel/*        Channel + 协作类 + ChannelState + RequestIdGenerator
   ├──→ adapters/*       inbound / outbound / media / auth 默认工厂（组装端口，ACL）
   └──→ ports/*          端口类型

index       ──→ bridge / application / adapters / channel / ports（组合根统一装配）
bridge      ──→ application（事件 → 用例委托）   bridge ──→ channel（窄接口：BridgeChannel）
application ──→ channel（窄端口：ReplyChannel / SessionChannel）
application ──→ storage/*（凭证读写） + ports/*（WechatAuth） + shared/*
channel     ──→ ports/*（inbound/outbound/media/pi-host）
channel     ──→ storage/* / shared/*
adapters    ──→ ports/* + vendor（api / auth / cdn / media / messaging / util）
ports       ──→ 仅 ports/types.ts 转发 vendor 的 api/types
shared      ──→ vendor/util（redact / file-logger 再导出边界）
storage     ──→ shared/*
```

- **禁止反向依赖**：`bridge` 不得被 `channel` / `application` / `ports` / `adapters` / `shared` / `storage` import；`channel` 不得 import `bridge`；`storage` 不得 import `channel` / `bridge`；`application` 不得 import pi / vendor / 具体 `Channel`（只依赖自有的窄接口、`storage`、`ports`、`shared`）。
- **端口层无运行时逻辑**：`src/ports/*.ts` 仅类型 / 常量（唯一例外是 `types.ts` 的 vendor 协议类型转发）。
- **隔离 vendor**：除 `src/adapters/**`、`src/ports/types.ts`、`src/shared/redact.ts`、`src/shared/file-logger.ts` 外，自写代码不 import `api/ auth/ cdn/ media/ messaging/ util/`。vendor 的耦合细节见 [`vendor-constraints.md`](../vendor-constraints.md)（RF-5 产出）。
- **通道不得回溯旧门面**：旧的引擎目录已删除，`channel` 只依赖端口与协作类。
- **组合根组装端口**：`src/index.ts` 创建 `ChannelState` 与 `inbound/outbound/media` adapters，并把同一 state 注入 outbound 的 `getCredentials` 与 `Channel`；`channel` 只依赖 `ports/*`、`storage/*`、`shared/*`，不 import adapters。

## 3. 模块职责与关键导出

### 3.1 组合根与端口 / 适配器

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/index.ts` | 组合根：`createExtension(deps?)` 显式组装 `application（SessionService/ReplyService）+ ChannelState + adapters（inbound/outbound/media）+ Channel + WechatAuth`；把 `ExtensionAPI` 适配为 `PiHost`；注册工具 / 命令 / 事件并向 `registerBridge` 注入窄接口 | `createExtension`、`ExtensionDeps`、`default` |
| `src/ports/types.ts` | 端口层类型边界：集中转发 vendor 协议类型与 `WechatCredentials` | `WeixinMessage`、`MessageItem`、`MessageItemType`、`WechatCredentials` |
| `src/ports/inbound.ts` | 入站端口：拉取更新 | `WechatInbound`、`WechatInboundGetUpdatesParams`、`WechatInboundGetUpdatesResult` |
| `src/ports/outbound.ts` | 出站端口：文本 / 文件 / typing / ticket | `WechatOutbound` |
| `src/ports/media.ts` | 媒体端口：下载单个 item | `WechatMedia`、`SaveMediaFn`、`WechatMediaDownloadDeps`、`WechatMediaDownloadResult` |
| `src/ports/auth.ts` | 登录端口：扫码 + 等待扫码 | `WechatAuth`、`WechatAuthStartQrOpts`、`WechatAuthStartQrResult`、`WechatAuthWaitForLoginOpts`、`WechatAuthWaitForLoginResult` |
| `src/ports/pi-host.ts` | 宿主端口：pi 的能力子集 | `PiHost` |
| `src/adapters/inbound.ts` | 包装 vendor `api/api.getUpdates`，映射 `{msgs,get_updates_buf}` → `{messages,cursor}` | `createWechatInbound` |
| `src/adapters/outbound.ts` | 包装 vendor 发送 / typing / ticket，凭证由注入 provider 提供 | `createWechatOutbound`、`WechatOutboundDeps`、`WechatOutboundLogger` |
| `src/adapters/media.ts` | 包装 vendor `downloadMediaFromItem`，3 参回调适配为 5 参 | `createWechatMedia`、`WechatMediaDeps`、`WechatMediaLog` |
| `src/adapters/auth.ts` | 包装 vendor `auth/login-qr` 两步登录 | `createWechatAuth` |

### 3.1a application（用例层）

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/application/reply.ts` | 回复发送用例：`agent_settled` 的发送决策（防重 → 提取回复 → 停止 typing → 发送 → **成功后**才 `markRequestProcessed`；失败不标记可重试 D2；`finally` 释放队列 D1） | `ReplyService`、`handleSettled(ctx)` |
| `src/application/session.ts` | 会话生命周期用例：`session_start` 自动连接、`/wechat login\|status\|start\|stop\|logout`、`session_shutdown`；所有「启动轮询」路径收敛到私有 `startPollingWith`（`setConfig` + `startPolling` 单点，消除双凭证来源） | `SessionService`、`SessionUi`、`SessionChannel` |
| `src/application/types.ts` | 用例输入 DTO 与窄端口：`SettledContext`、`ReplyChannel` | `SettledContext`、`ReplyChannel` |

> 依赖方向：`application/*` 只 import `./types`、`../shared/*`、`../storage/state`、`../ports/auth`；
> 不感知 pi / vendor / 具体 `Channel`（通过 `ReplyChannel` / `SessionChannel` 窄接口协作）。
>
> 由 `index` 构造并向 `registerBridge` 注入；`bridge/events.ts` 只做「事件 → DTO」，用例决策在 application。

### 3.2 bridge（pi 侧适配，事件翻译）

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/bridge/events.ts` | 注册全部 `pi.on`；`agent_settled` 发送决策委托 `ReplyService`，会话生命周期委托 `SessionService`；对 Channel 只依赖 `BridgeChannel` 窄接口 | `registerBridge`、`BridgeChannel`、`BridgeDeps` |
| `src/bridge/turn.ts` | turn 身份解析（近纯函数）+ `input` FIFO；状态收拢在 `TurnResolver` 实例（注入，无模块级 FIFO） | `TurnResolver`、`WechatTurn`、`BranchEntry`、`isAssistantMessage`、`extractLastReply`、`extractReplyText` |
| `src/bridge/meta.ts` | Git 分支缓存 + 运行信息（成本增量累计）；状态收拢在 `MetaBuilder` 实例 | `MetaBuilder`、`readGitBranch` |
| `src/bridge/session-ui.ts` | 把 pi `ExtensionContext` 的 `ui`/控制台/二维码适配为 `SessionUi` 窄接口 | `createSessionUi`、`SessionUi` |
| `src/bridge/commands.ts` | `/wechat` 命令注册（委托 `SessionService`） | `registerCommands` |
| `src/bridge/tool-send-file.ts` | `send_wechat_file` 工具定义；只依赖 `SendFileChannel` 窄接口（`sendFile`） | `createSendFileTool`、`SendFileChannel` |

### 3.3 channel（通道核心）

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/channel/channel.ts` | 粗粒度编排器：持有 `ChannelState` 与全部协作类，装配完整通道；对 bridge / application / tool 暴露公共方法 | `Channel`、`ChannelDeps`、`ChannelPorts` |
| `src/channel/state.ts` | 运行时会话状态：单用户凭证、运行期注入依赖（config/host/notifier）、终端处理标志（requestId 追踪已迁出到 `RequestIdGenerator`） | `ChannelState`、`Notifier` |
| `src/channel/request-id.ts` | 请求 ID 生成器：`YYMMDDHHMMSSmmm` + 3 位同毫秒序号，独立追踪同毫秒唯一性 | `RequestIdGenerator`、`next(now?)` |
| `src/channel/polling.ts` | 长轮询循环 / 退避 / abort-race / 重入守卫 / generation 令牌 / 连接状态 | `PollingLoop`、`PollingLoopDeps`、`ConnectionState`、`POLL_ABORTED`、`DEFAULT_LONG_POLL_TIMEOUT_MS`、`StartPollingOpts` |
| `src/channel/queue.ts` | 轮次队列纯状态（FIFO / 忙闲 / 去重）+ 后台串行任务队列 | `TurnQueue`、`SerialTaskQueue` |
| `src/channel/router.ts` | turn 执行（文本注入 / 媒体后台）+ 队列排空 | `MessageRouter`、`RouterDeps`、`RouterTurnOptions` |
| `src/channel/media-store.ts` | 媒体落盘、ISO 周目录、魔数/MIME 识别、批量下载 | `MediaStore`、`MediaStoreOptions`、`detectFileType`、`CONTENT_TYPE_EXT_MAP`、`getISOWeek`、`getCurrentWeekFolder` |
| `src/channel/typing.ts` | typing ticket 缓存（绑定 contextToken）+ keepalive | `TypingController`、`TypingDeps` |
| `src/channel/sender.ts` | 文本 / 文件出站发送 + 重试 | `MessageSender`、`SenderDeps` |

### 3.4 shared / storage

| 模块 | 职责 | 关键导出 |
|------|------|----------|
| `src/shared/config.ts` | 配置加载（文件 + 环境变量，按字段覆盖） | `loadConfig`、`isDebugEnabled`、`getMediaStoragePath`、`clearConfigCache`、`WechatPluginConfig`、`DEFAULT_CONFIG` |
| `src/shared/logger.ts` | 统一控制台日志 + 脱敏 | `createLogger`、`PluginLogger`、`LogLevel`、`LogSink`；再导出 `redactToken` / `redactBody` / `redactUrl` |
| `src/shared/redact.ts` | vendor `util/redact` 的薄再导出边界 | `redactToken`、`redactBody`、`redactUrl` |
| `src/shared/file-logger.ts` | vendor `util/logger` 的薄再导出边界 | `logger`、`setLogLevel` |
| `src/shared/time.ts` | 统一时间戳（`YYMMDDHHMMSSmmm`）+ sleep | `formatTimestamp`、`sleep` |
| `src/shared/paths.ts` | 状态目录解析 | `resolveStateDir` |
| `src/shared/types.ts` | 共享类型 | `WechatApiOpts` |
| `src/storage/state.ts` | 凭证 / 账号 / context token / sync cursor 持久化；原子写 + 按路径串行队列 + 单用户便捷函数 | `saveToken`、`getDefaultAccountToken`、`getSingleUserCredentials`、`getSingleUserContextToken`、`saveContextToken`、`loadSyncCursor`、`saveSyncCursor`、`upsertAccount`、`deleteAccountData`、`removeAccount` 等 |
| `src/storage/state-dir.ts` | 兼容层：再导出 `resolveStateDir` | `resolveStateDir` |

## 4. 关键机制

### 4.1 turn 识别与 `agent_settled` 发送（决策在 `ReplyService`）

- 微信文本 turn 在 `MessageRouter.execute()` 中先 `host.appendEntry("wechat_meta", { requestId })`，再 `host.sendUserMessage(content, { deliverAs: "followUp" })`。
- `bridge/events.ts` 把 `agent_settled` 翻译成 `SettledContext`（`fromWechat` / `requestId` / `replyText` / `metaText` + `notify` 回调），发送决策交给 `application/reply` 的 `ReplyService.handleSettled()`；bridge 本身不承载发送逻辑。
- 每轮身份不做跨轮存储：
  - `input` 事件把注入文本按 FIFO 入队（`pushPendingWechatInput`）。
  - `before_agent_start` 用 `resolveTurnBeforeRun()`：从分支叶子向前找 `wechat_meta`，若先遇到 assistant 则为终端 turn；找不到时用 `event.prompt` 与 FIFO 兜底。
  - 运行中/结束后用 `resolveTurnFromBranch()`：以最后一条 user 消息的 `parentId` 反查 `wechat_meta`。
- 最终回复在 **`agent_settled`** 发送（一轮只发一次，覆盖重试/压缩/续跑后的最终版）；`agent_end` 只负责 typing 收敛与终端标志兜底。
- 发送成功后才 `channel.markRequestProcessed(requestId)`；失败可重试（D2）。所有路径 `finally` 调 `channel.onAiDone()` 释放队列（D1）。
- `message_start`/`message_end` **仅对 assistant 消息**控制 typing（D18）。

### 4.2 轮询：重入守卫 / generation / abort-race

- `PollingLoop` 的 `pollingActive` 单飞行守卫：已有会话在跑则 `start()` 直接返回，杜绝并发轮询（D3）。
- `pollingGeneration` 令牌：`reset()`/新会话令旧令牌过期，旧循环拿到过期结果后丢弃，不污染新状态。
- 底层 `WechatInbound.getUpdates` 不接受 `AbortSignal`（D9）：用 `createAbortWaiter()` 构造 reject(`POLL_ABORTED`) 的 promise 与请求 `Promise.race`；`stop()` 触发 abort 使循环迅速退出，在途 HTTP 后台自行超时。
- 会话过期（`errcode/code === -14`）→ `connectionState = "needs_relogin"`，触发 `onNeedsRelogin()` 用户通知；`finally` 不覆盖该终态（B4）。
- `PollingLoopDeps` 反向注入宿主能力（`ensureSession` / `getAccountId` / `loadCursor` / `saveCursor` / `inbound` / `onMessage` / `onNeedsRelogin` / 日志 / sleep），`PollingLoop` 自身不依赖 `storage`。

### 4.3 `TurnQueue` 与 requestId 唯一性

- `TurnQueue<T>`：`pending` FIFO、`busy`、`currentRequestId`、`processed: Map<id, ts>`。
- `markRequestProcessed` 每 50 次触发一次清理（删除 1 小时前的记录）。
- requestId = `formatTimestamp()`（15 位）+ 3 位同毫秒序号，保证同毫秒内唯一（D13）。生成收拢在 `channel/request-id.ts` 的 `RequestIdGenerator`（`Channel` 私有 `generateRequestId()` 委托 `requestId.next()`），`ChannelState` 不再承载 requestId 追踪。
- `SerialTaskQueue` 用 promise 链保证后台任务串行；单个任务抛错经 `onError` 上报且不阻断后续。

### 4.4 媒体后台串行（B5）

- 纯媒体消息（有媒体、无文本）：`MessageRouter.execute()` 先立即回执「媒体文件已收到，正在保存…」，然后 `mediaQueue.enqueue(processMediaInBackground)`，随后 `markRequestProcessed` 并排空。
- `MediaStore.downloadAll()` 逐个经 `WechatMedia` 端口下载，单项失败仅记录并继续；成功后通过 `host.sendMessage({ customType: "wechat_media", ... }, { triggerTurn: false, deliverAs: "followUp" })` 把路径写入会话历史（不触发新 turn）。
- 落盘路径：`{mediaStoragePath}/{YY}{WW}/{YYMMDDHHMMSSmmm}_{uuid8}.{ext}`，扩展名优先级为原文件名后缀 > contentType > 魔数 > `bin`。
- 端口薄：`WechatMedia.download()` 只负责下载/解密并返回路径；目录、命名与类型判定全部由 `MediaStore` 通过 `SaveMediaFn` 回调注入。

### 4.5 Typing keepalive

- `TypingController` 经 `WechatOutbound` 端口取 `typing_ticket`，缓存 TTL 60s 且**绑定 contextToken**（token 变化立即失效，D16）。
- `startKeepalive()` 先发 `typing=1`，再 `setInterval(8000ms)` 刷新；定时器 `unref()`，不阻止进程退出。
- `message_end`/`agent_end`/`agent_settled` 停止 keepalive；发送失败且错误含 "ticket" 时清缓存。
- `Channel.handleMessage()` 在 contextToken 变化时调用 `typing.invalidateTicket()` 并持久化新 token。

### 4.6 发送与重试

- `MessageSender.sendWithRetry()` 入口先经 `canSend()` 检查凭证：缺凭证立即抛 `"Single user not initialized"`，不调用底层、不进入重试、不 sleep（D14 相关回归保持）。
- 发送成功才由 `ReplyService` 标记 `markRequestProcessed`（失败不标记、可重试 D2）；重试采用指数退避 `1000 * 2^(attempt-1)`。

### 4.7 日志与脱敏

- 全仓库统一走 `createLogger()`；`debug` 仅在 `isDebugEnabled()` 为真时输出，**每次调用求值**，支持测试动态开关。
- `sanitize()`：`Error` 只取 `message`（不带 stack）；字符串/对象先 `redactBody` 脱敏（token、context_token 等敏感 JSON 键）再打印；不可序列化对象退化为 `String`，保证日志自身不抛错（B7）。
- `storage/state.ts` 经 `shared/file-logger.ts` 使用 vendor 文件日志；`shared/redact.ts` / `shared/file-logger.ts` 是仅有的两个 vendor 再导出边界。

### 4.8 依赖注入

- `PiHost` 是 `ExtensionAPI` 的窄接口（仅 `appendEntry` / `sendUserMessage` / `sendMessage`）；`index.ts` 的 `piToHost()` 负责适配，`Channel.setHost()` / `state.host` 持有，测试无需实现整个 `ExtensionAPI`（R1）。
- `createExtension(deps?)` 接受 fake `Channel` / `WechatAuth`；默认每次调用创建独立 `Channel`，不共享模块单例。
- `Channel` 构造函数接受 `ChannelDeps`（`state` / `host` / `config` / `notifier` / `ports` / `logger` / `sleep`）；`ports` 提供 `{ inbound?, outbound?, media? }` 供测试注入 fake。
- 协作类各自接受窄 deps：`PollingLoopDeps` / `RouterDeps` / `TypingDeps` / `SenderDeps` / `MediaStoreOptions`。

### 4.9 会话生命周期（`application/session`）

- `SessionService` 是会话生命周期的唯一入口：`session_start` 自动连接（`startFromStoredToken`）、`/wechat login|start|stop|logout|status`、`session_shutdown`（`shutdown`）。
- 所有「启动轮询」路径共用私有 `startPollingWith(opts, onError, afterSetConfig?)`：先 `setConfig` 同步凭证，再 `startPolling`；两处调用只出现一次，消除旧的 `setConfig` 与 `startPolling(opts)` 双凭证来源分叉（A3 类问题）。
- 登录成功摘要只输出脱敏后的字段（D11）；行为不变性（文案 / 存储调用集合 / 轮询错误提示）与迁移前逐字一致（rf-2 行为契约，由 `tests/bridge` 回归）。

### 4.10 窄接口面（bridge / application / tool 均不依赖具体 `Channel`）

| 窄接口 | 定义处 | 面向消费者 | 成员 |
|---|---|---|---|
| `BridgeChannel` | `bridge/events.ts` | `registerBridge` | `setNotifier` / `setTerminalProcessing` / `startTyping` / `stopTyping` |
| `SendFileChannel` | `bridge/tool-send-file.ts` | `send_wechat_file` 工具 | `sendFile` |
| `ReplyChannel` | `application/types.ts` | `ReplyService` | `isRequestProcessed` / `stopTyping` / `sendReply` / `markRequestProcessed` / `setTerminalProcessing` / `onAiDone` |
| `SessionChannel` | `application/session.ts` | `SessionService` | `connectionState` / `setConfig` / `startPolling` / `stopPolling` / `reset` |

`Channel` 实现这些窄接口的全部成员；消费者按需收敛依赖面，测试可注入对应 fake。

### 4.11 轮询同步 `connecting`（A3）

- `PollingLoop.start()` **同步**把 `connectionState` 置为 `connecting`（在首次 `getUpdates` 之前），覆盖「已启动但首次 getUpdates 尚未返回」的窗口；首次 `getUpdates` 成功后置 `connected`。
- 重启 pi 后 `/wechat status` 不再停留在旧的未连接状态（A3 修复，`tests/channel` 回归）。

### 4.12 单条消息失败隔离与媒体 ack 失败隔离（F6）

- `polling.ts`：单条 `onMessage` 处理失败只记录错误，不中断该批次轮询循环，后续消息继续处理（F6「连发多图后文本阻塞」修复）。
- `router.ts`：媒体落盘后的 `wechat_media` ack（`host.sendMessage`）失败仅记录日志，不阻断媒体批次与队列排空。
- `sync.json` 的 syncCursor 随轮询持续推进，不受失败消息影响。

### 4.13 存储健壮性

- **原子写**：先写同目录临时文件再 `renameSync` 覆盖，目标文件要么旧内容要么完整新内容（D12）。
- **按路径串行队列**：同一路径的读-改-写按调用顺序执行，避免并发丢写；不同路径互不阻塞。
- `token.json` 以 `chmod 600` 写入。
- `getSingleUserContextToken()` 按 `token.userId` 精确读取（D10），不取 `context-tokens.json` 的第一个 key。

## 5. 与 openclaw-weixin 迁移模块的依赖关系

`api/ auth/ cdn/ media/ messaging/ util/` 迁移自 Tencent/openclaw-weixin，视为**外部适配层**（vendor）。重构后自写代码只在 `src/adapters/` 与两个再导出边界调用下列函数（不展开其内部实现）；不可动的耦合、维护规则与端口责任边界见 [`docs/vendor-constraints.md`](../vendor-constraints.md)（RF-5 产出）。

| 自写调用点 | vendor 模块 | 调用面 |
|------------|-------------|--------|
| `adapters/inbound.ts` | `api/api.ts` | `getUpdates` |
| `adapters/outbound.ts` | `api/api.ts` | `getConfig`、`sendTyping` |
| `adapters/outbound.ts` | `messaging/send.ts` | `sendMessageWeixin` |
| `adapters/outbound.ts` | `messaging/send-media.ts` | `sendWeixinMediaFile` |
| `adapters/media.ts` | `media/media-download.ts` | `downloadMediaFromItem` |
| `adapters/auth.ts` | `auth/login-qr.ts` | `startWeixinLoginWithQr`、`waitForWeixinLogin`、`DEFAULT_ILINK_BOT_TYPE` |
| `ports/types.ts` | `api/types.ts` | `WeixinMessage`、`MessageItem`、`MessageItemType`（类型转发） |
| `shared/redact.ts` | `util/redact.ts` | `redactToken`、`redactBody`、`redactUrl`（再导出边界） |
| `shared/file-logger.ts` | `util/logger.ts` | `logger`、`setLogLevel`（再导出边界） |

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
  - 分层运行：`bun test --isolate tests/unit`、`tests/channel`、`tests/bridge`、`tests/integration`。
  - `bun run typecheck`：`tsc --noEmit`（底层迁移模块有 3 条既有 TS2307 例外，见 `tests/README.md`）。
- **CI**：Forgejo Actions（`.forgejo/workflows/ci.yml`）在 push / PR 时执行 `bun install --frozen-lockfile` → `bun run test` → `bun run typecheck`。

### 7.2 项目结构

```
├── src/
│   ├── index.ts          # 组合根：createExtension(deps?) 组装 application + Channel + adapters + WechatAuth
│   ├── application/      # 用例层：reply（ReplyService）/ session（SessionService）/ types（DTO + 窄接口）
│   ├── bridge/           # pi 侧适配（事件翻译）：events / turn / meta / commands / session-ui / tool-send-file
│   ├── channel/          # 通道核心：channel / state / request-id / polling / queue / router / media-store / typing / sender
│   ├── ports/            # 端口接口：inbound / outbound / media / auth / pi-host / types
│   ├── adapters/         # 微信侧薄包装（ACL）：inbound / outbound / media / auth（唯一接触 vendor）
│   ├── shared/           # 基础：config / logger / time / paths / types / redact(边界) / file-logger(边界)
│   └── storage/          # 持久化：state / state-dir
├── api/ auth/ cdn/ media/ messaging/ util/   # 迁移自 openclaw-weixin（vendor，边界与调用面见第 5 节）
├── tests/                # 缺陷回归测试 + 分层夹具（unit / channel / bridge / integration / setup）
├── .forgejo/workflows/   # CI
└── package.json          # scripts: test / typecheck；engines.node >= 22
```

### 7.3 测试分层

| 层 | 目录 | 被测对象 |
|----|------|----------|
| L1 纯逻辑 | `tests/unit` | `shared/config`、`shared/logger`、`storage/state`、端口适配器 `adapters`、`channel/state`、依赖清单 |
| L2 通道 | `tests/channel` | 直接测 `Channel`（注入端口 fake）+ 纯协作类 `queue` / `media-store` / `router` |
| L3 事件桥接 | `tests/bridge` | `index` 的事件接线、`turn`、`meta`（注入 fake `Channel` / `WechatAuth`） |
| 集成 | `tests/integration` | `channel-flow.test.ts`：端到端通道流转 |

回归用例与 D1–D22 缺陷对照见 [`tests/README.md`](../tests/README.md)。迁移模块的边界与调用面见第 5 节；自写层只调用其公开函数，不修改其内部实现。

## 8. 扩展与维护指引

- **新增 pi 事件/命令/工具** → `src/bridge/`（保持薄，只做事件解析与委托；经 `BridgeChannel` / `SendFileChannel` 等窄接口调用 `Channel`）。
- **发送决策 / 会话生命周期等用例变更** → `src/application/`（`ReplyService` / `SessionService`）；不要直接 import pi / vendor / 具体 `Channel`，只依赖 `ReplyChannel` / `SessionChannel` 窄接口。
- **轮询/队列/发送/typing/媒体等通道能力变更** → `src/channel/` 对应协作类；不要把 vendor（HTTP/上传/解密）逻辑写进 `channel`。
- **新增微信边界调用** → 先在 `src/ports/` 定义窄接口，再在 `src/adapters/` 实现包装，最后经 `ChannelDeps.ports` 注入；`channel` 不直接 import vendor。
- **配置/日志/时间等通用能力** → `src/shared/`。
- **凭证、cursor、context token 等持久化** → `src/storage/`；新增写操作请复用 `writeJsonAtomic` + 按路径串行队列。
- **不要绕过 `PiHost` 窄接口**：新增 pi 依赖时扩展 `PiHost` 并在 `index.ts` 的 `piToHost()` 适配，保持测试可注入。
- **消费者不依赖具体 `Channel`**：新增 bridge / tool / application 消费时先定义窄接口，由 `Channel` 实现；改动 `Channel` 公共面时同步更新四个窄接口矩阵（见 4.10）。
- 开发/测试流程与分层见第 7 节；提交前保持 `bun run test` 与 `bun run typecheck` 通过。
