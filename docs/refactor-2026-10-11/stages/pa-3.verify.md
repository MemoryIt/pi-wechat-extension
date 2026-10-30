# Verify Report: PA-3（engine 改用端口 + 测试 mock 迁移到端口 fake）

- task: pa-3
- base: `dev` @ `5d4388eaf7ad20ef46f7d746c9ec0e02aeaac567`（merge-base == dev，dev 为 HEAD 祖先）
- verified-branch: `refactor/pa-3-engine-use-ports` @ `38270c10a36c9c97d57ba141a25ffa5cde73068c`
- 线性提交：4 个（`git rev-list --count dev..HEAD` = 4）
- mode: 只读（未修改代码、未提交、未 push；仅写本报告；工作树验证前后均 clean）
- verdict: **PASS**

## 结论

PA-3 的全部 acceptance 通过，端口边界收口干净、测试 mock 迁移完成、关键回归语义未退化。
`bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，实测 **115 pass / 13 files / 0 fail / 292 expect**，
基线实测 **114 pass / 13 files / 0 fail / 290 expect**（净 +1），逐文件计数与 result 的 test-changes 完全一致。
vendor 目录零 diff；`src/bridge/{events,commands,tool-send-file}.ts` 零 diff；引擎/bridge 对 vendor 的 import 全部消除。
仅发现一处**非阻塞**实现级差异（`sendWithRetry` 缺凭证时由「立即抛」变为「重试后抛」），见文末备注，不影响任何 acceptance 与回归断言。

## 证据（命令输出）

### 1. install / typecheck / test 全绿（贴计数）

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
Checked 131 installs across 139 packages (no changes) [3.00ms]        # exit 0

$ bun run typecheck
$ tsc --noEmit                                                        # exit 0，无输出

$ bun run test
...
 115 pass
 0 fail
 292 expect() calls
Ran 115 tests across 13 files. [728.00ms]                            # exit 0
```

- `rg -c "\(pass\)"` = **115**，`rg "\(fail\)"` = 空。
- ✅ 三个命令全部 exit 0。

### 2. 测试数 ≥ 基线，且与 result 的 test-changes 一致

在 `/tmp` 用 `git archive dev` 独立复跑基线（不改动仓库/分支）：

```
$ git archive dev | tar -x -C /tmp/pa3-baseline   # 仅解包 + symlink node_modules
$ bun run test
 114 pass / 0 fail / 290 expect() calls / Ran 114 tests across 13 files.   # exit 0
```

逐文件计数对比（`rg -c '^\s*(test|it)\('`）：

| 文件 | dev（基线） | HEAD | Δ |
|---|---|---|---|
| tests/engine/engine.test.ts | 17 | 19 | **+2** |
| tests/engine/media-store.test.ts | 11 | 12 | **+1** |
| tests/unit/adapters.test.ts | 21 | 19 | **−2** |
| 其余 10 个文件 | 65 | 65 | 0 |
| **合计** | **114** | **115** | **+1** |

- 新增 2（engine.test.ts：D16 TTL 过期重取；sendTyping 报错含 "ticket" 清缓存后重取）。
- 新增 1（media-store.test.ts：downloadAll 经端口 saveMedia 回调落盘并返回 `{ path }`）。
- adapters.test.ts −2：outbound 去缓存后合并旧缓存用例（改断「直连 getConfig 不缓存」/「传入 ticket」/「冒泡」）。
- 文件数 13 恒定；无删除、无重命名（`git diff --name-status` 全为 `M`），与 result 声明一致。
- ✅ 用例数 ≥ 基线且逐文件与 result 完全吻合。

### 3. `git diff dev...HEAD --stat` 未越界；vendor 目录 diff 为空

```
$ git diff dev...HEAD --stat
 src/adapters/inbound.ts          |   4 +-
 src/adapters/outbound.ts         |  67 ++++-------------
 src/bridge/login.ts              |  15 ++--
 src/engine/media-store.ts        |  52 ++++++--------
 src/engine/polling.ts            |  16 +++--
 src/engine/router.ts             |   4 +-
 src/engine/sender.ts             |  54 ++------------
 src/engine/typing.ts             |  61 ++++++----------
 src/engine/wechat.ts             |  88 +++++++++++++++++------
 src/ports/outbound.ts            |   5 +-
 tests/engine/engine.test.ts      | 152 ++++++++++++++++++++++++++-------------
 tests/engine/media-store.test.ts |  81 ++++++++++++++-------
 tests/engine/router.test.ts      |   4 +-
 tests/setup/engine-harness.ts    | 125 +++++++++-----------------------
 tests/unit/adapters.test.ts      |  72 +++++--------------
 15 files changed, 368 insertions(+), 432 deletions(-)

$ for d in api auth cdn media messaging util types; do git diff dev...HEAD --stat -- "$d"; done
（7 个目录全部无输出）
$ git diff dev...HEAD --name-only -- api auth cdn media messaging util types
（空）
```

- ✅ 改动文件集合 == pa-3 scope（ports/outbound、adapters/{inbound,outbound}、engine/{polling,typing,sender,media-store,wechat,router}、bridge/login、对应 tests）。
- ✅ vendor（api/ auth/ cdn/ media/ messaging/ util/）与 `types/` **零 diff**。
- ✅ package.json / bun.lock / tsconfig.json 零 diff（未新增依赖）。

### 4. 逐条核对 pa-3.md 的 acceptance

| acceptance 条目 | 结果 | 证据 |
|---|---|---|
| typecheck+test 全绿，用例数 ≥ 114，语义不降 | ✅ | 115/13/0，基线 114/13/0；逐文件语义见 §7 |
| `rg "from \"\.\./\.\./(api\|messaging\|media\|auth)/" src/engine src/bridge` 为空 | ✅ | exit 1（无匹配） |
| `rg "api/types" src/engine src/bridge` 为空（改 `ports/types`） | ✅ | exit 1；`api/types` 仅存在于 `src/ports/types.ts`（端口层唯一转发点） |
| `rg "\.\./\.\./(api\|messaging\|media\|auth)/\|\.\./\.\./util/" src/engine src/bridge` 为空 | ✅ | exit 1 |
| engine-harness 不再 `mock.module` vendor | ✅ | `rg "mock.module" tests/setup/engine-harness.ts` exit 1 |
| WechatEngine 公共 API 未变（diff 仅内部实现） | ✅ | 逐成员比对见 §6 |
| `adapters/outbound.ts` 无内部缓存；adapters.test.ts 相应更新并通过 | ✅ | 见 §5；`TYPING_TICKET_CACHE_TTL_MS`/`ticketCache` 已删除 |
| vendor 目录零 diff | ✅ | 见 §3 |
| 提交原子、message 规范 | ✅ | 4 个独立 commit，全部 `type(scope): subject` 中文规范；未 push、未改 dev |

### 5. 端口薄化与设计要点

- `src/ports/outbound.ts`：`sendTyping(status: 1|2, ticket: string): Promise<void>`；`getTypingTicket()` 文档注明「直连 getConfig，无缓存」。
- `src/adapters/outbound.ts`：
  - 删除 `TYPING_TICKET_CACHE_TTL_MS` 与 `ticketCache`；`getTypingTicket` 每次直连 `getConfig`；
  - `sendTyping(status, ticket)` 直接用传入 ticket 调用 vendor `sendTyping`，凭证缺失直接 return，底层错误向上冒泡（清缓存交给 TypingController）；
  - `sendText`/`sendFile` 仍保留凭证缺失抛 `"Single user not initialized"` 的旧行为。
  - 单测 `tests/unit/adapters.test.ts` 同步：`getTypingTicket 直连 getConfig，不缓存`、`sendTyping(status, ticket) 直接用传入 ticket，不取配置`、`sendTyping 底层抛错向上冒泡`。
- `src/adapters/inbound.ts`：`cursor: resp.get_updates_buf ?? params.cursor`（对齐旧 `PollingLoop` 的「缺字段回落旧 cursor」；修复 PA-2 verify 记录的未决项）。单测 `inbound：响应字段缺失时 … cursor 沿用入参` 断 `"cursor-keep"`。
- `src/engine/wechat.ts`：构造 `createWechatInbound/Outbound/Media` 并注入协作类；构造函数接受可选 `{ inbound?, outbound?, media? }`；类型 import 全部来自 `../ports/types.js`。

```
$ rg -n "adapters/" src --glob '!src/adapters/**'
src/engine/wechat.ts:16:import { createWechatInbound } from "../adapters/inbound.js";
src/engine/wechat.ts:17:import { createWechatOutbound } from "../adapters/outbound.js";
src/engine/wechat.ts:18:import { createWechatMedia } from "../adapters/media.js";
src/bridge/login.ts:9:import { createWechatAuth } from "../adapters/auth.js";
```

- ✅ 仅组合点（wechat.ts / login.ts）引用 adapters；engine/bridge 其余文件不再触碰 vendor。

### 6. `WechatEngine` 公共 API 逐成员比对（dev vs HEAD）

对 `dev:src/engine/wechat.ts` 与 HEAD 提取公共成员，结果：

```
setHost / setNotifier / setConfig / configure / get connectionState
getTerminalProcessing / setTerminalProcessing / initSingleUser / stopPolling / startPolling
handleMessage / triggerAi / onAiDone / getTypingTicket / sendTypingStatus
startTypingKeepalive / stopTypingKeepalive / sendTextMessage / sendFileToUser
sendMessageWithRetry / getCurrentRequestId / isRequestProcessed / markRequestProcessed
cleanupProcessedRequests / reset
```

- 方法名、参数、返回类型逐条一致。
- 唯一差异：`constructor()` → `constructor(ports: WechatEnginePorts = {})`，为**新增可选参数**（任务书显式允许「构造函数接受可选注入」）；`createWechatEngine(initial?)` 的 `initial` 类型由 `{host?,config?}` 扩展为 `WechatEngineDeps`（同样纯新增可选字段）。旧调用 `new WechatEngine()` / `createWechatEngine()` / `createWechatEngine({host,config})` 均不受影响。
- `git diff dev...HEAD -- src/engine/wechat.ts` 中除 constructor/factory 外均为内部实现（import、字段初始化、router/poller 注入）。

### 7. 关键回归语义覆盖（逐条：用例仍在且通过）

| 用例 | 文件 | 断言要点 | 状态 |
|---|---|---|---|
| D6 | engine.test.ts `D6 目标：sendUserMessage 抛错后应释放 isAiProcessing 且不冒泡` | queue.isBusy()=false、connectionState=disconnected、不冒泡 | ✅ pass |
| D7 | engine.test.ts `D7 目标：队列排空时 rejecting turn 应由引擎处理并释放状态` | onAiDone 后排空、状态释放 | ✅ pass |
| D9 | engine.test.ts `D9 限制说明…` + `D9 目标：stopPolling 后 startPolling 应在 300ms 内 resolve` | 无 AbortSignal 透传、Promise.race 快速退出 | ✅ pass |
| D13 | engine.test.ts `D13 目标：同一毫秒内的 requestId 应保持唯一` | 同毫秒不重复 | ✅ pass |
| D14 | engine.test.ts `基线：sendFileToUser 以本地文件路径提交底层发送…` | `outboundMock.sendFile` 收到 `/tmp/sample.pptx` 且仅 1 参（无 display-name） | ✅ pass |
| D16 | engine.test.ts ×3：contextToken 变化重取 / 60s TTL 过期重取 / sendTyping 报错含 "ticket" 清缓存重取 | ticket 缓存三语义 | ✅ pass |
| D16b | engine.test.ts `D16b 目标：typing keepalive 的 interval 应调用 unref` | unref 被调用 | ✅ pass |
| B5 | engine.test.ts ×2：媒体立即 ack 不含路径、后台串行（第 2 条等第 1 条 resolve） | 不阻塞轮询、串行 | ✅ pass |

- 另：D3（轮询重入）、D15（slash）、B4（needs_relogin 终态 + 通知）、B6（排队 requestId 一一对应）、C9（实例隔离）均保留且通过。
- ✅ 未发现回归用例被删除/弱化；测试迁移仅把观测点从 vendor mock 改到端口 fake。

### 8. 端口职责边界（薄端口 / 状态归属）

- **TypingController（`src/engine/typing.ts`）**：保留
  - `TYPING_TICKET_CACHE_TTL_MS = 60_000`；
  - 缓存键 `contextToken`（`typingTicketCache.contextToken === contextToken`，不匹配即失效）；
  - `invalidateTicket()`；
  - `sendStatus` catch 中 `errMsg.includes("ticket")` → `typingTicketCache = null`；
  - keepalive 8000ms + `timer.unref?.()`。
- **PollingLoop（`src/engine/polling.ts`）**：保留
  - `pollingActive` 重入守卫；`pollingGeneration` generation 令牌；
  - `createAbortWaiter` + `Promise.race` abort-race；
  - `needs_relogin` 终态（finally 中不被 disconnected 覆盖）；
  - 经 `deps.inbound.getUpdates({cursor,baseUrl,token,timeoutMs})` 使用 `{messages,cursor}`；游标回落由 adapter `?? params.cursor` 保证。
- **MediaStore（`src/engine/media-store.ts`）**：落盘策略仍在本类（`save`：ISO 周目录、originalFilename>contentType>魔数>bin、`{timestamp}_{uuid8}.{ext}`、`writeFileSync`）；`clear` 通过 `media.download(item,{cdnBaseUrl,saveMedia,label})` 下载，`saveMedia = createSaveCallback()`（3 参端口回调）；单项失败 `errLog` 后继续。
- **`src/adapters/media.ts`**：仅做 3 参→vendor 5 参回调适配与 `decrypted{Pic,Voice,File,Video}Path` 取值，无目录/命名/魔数逻辑。

### 9. bridge 行为未改

```
$ git diff dev...HEAD -- src/bridge/events.ts src/bridge/commands.ts src/bridge/tool-send-file.ts
（空）
$ git diff dev...HEAD --stat -- src/bridge
 src/bridge/login.ts | 15 +++++++++------
 1 file changed, 9 insertions(+), 6 deletions(-)
```

- `login.ts` 仅把 `startWeixinLoginWithQr/waitForWeixinLogin/DEFAULT_ILINK_BOT_TYPE` 替换为 `auth.startQr/waitForLogin`（注入 `WechatAuth`，缺省 `createWechatAuth()`）；`botType` 由 adapter 缺省为 `DEFAULT_ILINK_BOT_TYPE`，等价旧 `botType: DEFAULT_ILINK_BOT_TYPE`；D11 脱敏、保存凭证、setConfig、启动轮询逻辑未动。
- `events.ts/commands.ts/tool-send-file.ts` 字节级零改动。

### 10. 无 vendor 隐式 mock 残留

```
$ rg -n "mock\.module" tests/setup/engine-harness.ts
（无输出，exit 1）
```

- `engine-harness.ts` 改为导出 `inboundMock/outboundMock/mediaMock` + `resetPortMocks()`，测试经 `createWechatEngine({inbound,outbound,media})` 注入；`MessageItemType` 直接取自 `src/ports/types.js`。
- 其余 vendor `mock.module` 仅存在于「adapter 单测」（`tests/unit/adapters.test.ts`）与「bridge harness / turn-state」（mock `src/engine/wechat` 与 `auth/login-qr`），均为既有合理用法，验收只要求 engine-harness 不 mock vendor，符合。
- 旧 harness 导出（`resetBoundaryMocks`/`controllableGetUpdates`/`apiMock`/`sendMediaMock`）无残留引用（`rg` 全仓库除 adapters.test.ts 自身外为空）。

### 11. 提交原子性与规范

```
38270c1 test(engine): mock 迁移到端口 fake
5c16704 refactor(bridge): login 经 WechatAuth 端口
88a141e refactor(engine): 经 ports 访问微信边界
3ba22a5 refactor(ports/adapters): outbound 薄化(ticket 参数) + inbound 游标回落
```

- 4 个逻辑独立 commit，与建议拆分一一对应；`git diff --check` 无空白错误。
- dev 为 HEAD 祖先；未 push（`git ls-remote origin` 无 `pa-3` 分支）；工作树验证前后 `git status --porcelain` 均为空。

## 备注（非阻塞）

1. **`sendWithRetry` 缺凭证时的重试语义发生极轻微变化**：
   - dev `src/engine/sender.ts` 在 `sendWithRetry` 入口先 `getCredentials()`，缺凭证立即抛 `"Single user not initialized"`（不重试）；
   - HEAD 去掉了该前置检查，缺凭证时进入重试循环，由 `outbound.sendText` 抛同一错误，重试 3 次（含 `sleep(1s)+sleep(2s)`）后抛同一错误，并多产生 2 条 `logger.error`。
   - 影响面：仅「凭证缺失」这一异常路径；最终抛出的错误对象/消息不变，且不发任何底层网络请求（outbound 在凭证缺失时直接 return/throw），因此不产生外部副作用。生产调用链（`events.ts`）在已登录后调用，凭证存在时行为完全一致。
   - 无任何测试覆盖该缺凭证分支（dev/HEAD 均无），不构成测试退化，也不在 pa-3 acceptance 清单内。记录供后续 PA-6/PA-7 注意。
2. `tests/setup/mocks.ts` 仍 `mock.module("util/logger.js")`（基础 mock，PA-3 未改），属既有基线，不在本阶段 vendor 收口范围内。
3. 单独 `bun test tests/bridge/` 存在基线即有的 `setLogLevel` mock 隔离问题（PA-3 result 已记录）；仓库约定入口 `bun run test`（`--isolate` 全量）115 全绿，与本次验证无关。

## 判定

**PASS** — 全部 acceptance 与 verify 专项检查通过，端口边界收口干净、测试 mock 迁移完成、回归语义未退化。
建议执行 `git merge --ff-only refactor/pa-3-engine-use-ports`。
