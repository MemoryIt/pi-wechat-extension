# Verify Report: PA-4（抽取 ChannelState + 修回 sendWithRetry 前置检查）

- task: pa-4
- base: `dev` @ `38270c10a36c9c97d57ba141a25ffa5cde73068c`（== PA-3 tip；dev 为 HEAD 祖先）
- verified-branch: `refactor/pa-4-channel-state` @ `ec14f4120e05cbf73a60ef31e83a9c5af094f5b3`（detached HEAD 与分支 ref 同点）
- 线性提交：4 个（`git rev-list --count dev..HEAD` = 4）
- mode: 只读（未修改代码、未提交、未 push；仅写本报告；验证前后工作树 clean）
- verdict: **PASS**

## 结论

PA-4 的全部 acceptance 通过：`ChannelState` 抽取干净、依赖方向正确（channel 不反向依赖 engine），
`WechatEngine` 公共 API 与 `reset()` 语义保持不变，`sendWithRetry` 缺凭证前置检查已恢复且有测试覆盖，
vendor 与 bridge 关键文件零 diff，关键回归用例全员在册并通过，4 个提交原子规范。

仅两处**非阻塞**观察（见文末备注），不影响任何 acceptance 与回归断言。

## 证据（命令输出）

### 1. install / typecheck / test 全绿（贴计数）

```
$ bun install --frozen-lockfile
install exit=0            # Checked 131 installs across 139 packages (no changes)

$ bun run typecheck
$ tsc --noEmit            # exit 0，无输出

$ bun run test
test exit=0
 121 pass
 0 fail
 330 expect() calls
Ran 121 tests across 14 files. [699.00ms]
```

- `rg -c "\(pass\)"` = **121**，`rg -c "\(fail\)"` = 0。
- ✅ 三个命令全部 exit 0。

### 2. 测试数 ≥ 基线（115/13/0），与 result 的 test-changes 一致

用 `git archive dev` 独立复跑基线（只解包到 `/tmp/pa4-dev`，symlink node_modules，不改仓库）：
dev 基线实测 `115 pass / 13 files / 0 fail`，与任务书基线一致。

逐文件用例计数对比（`rg -c '^\s*(test|it)\('`）：

| 文件 | dev | HEAD | Δ |
|---|---|---|---|
| tests/engine/engine.test.ts | 19 | 21 | **+2** |
| tests/unit/channel-state.test.ts | 0（不存在） | 4 | **+4（新增）** |
| 其余 12 个测试文件 | 96 | 96 | 0 |
| **合计** | **115** | **121** | **+6** |

- 与 result 声明的 `基线 115 → 121（净 +6；13 → 14 files）` 完全一致。
- `tests/unit/channel-state.test.ts` 4 条：默认值 / 字段读写 / resetSession 清凭证+终端+计数且保留 config/host/notifier / 重复 resetSession 幂等。
- `tests/engine/engine.test.ts` +2：`sendWithRetry 缺凭证：立即抛错、不调用底层发送、不进入重试`、`sendWithRetry 凭证就绪：正常走底层发送（一次成功）`。
- 无删除、无重命名；既有断言语义保持（仅两处私有字段观测点改走 `state.*`）。
- ✅ 用例数 ≥ 基线且逐文件与 result 吻合。

### 3. `git diff dev...HEAD --stat` 未越界；vendor 目录 diff 为空

```
$ git diff dev...HEAD --stat
 src/channel/state.ts             |  51 ++++++++++++++++++
 src/engine/sender.ts             |   9 ++++
 src/engine/wechat.ts             | 113 +++++++++++++++++++------------------------
 tests/engine/engine.test.ts      |  28 +++++++++-
 tests/unit/channel-state.test.ts |  98 +++++++++++++++++++++++++++++++++
 5 files changed, 228 insertions(+), 71 deletions(-)

$ git diff dev...HEAD --name-only
src/channel/state.ts
src/engine/sender.ts
src/engine/wechat.ts
tests/engine/engine.test.ts
tests/unit/channel-state.test.ts

$ for d in api auth cdn media messaging util types; do echo -n "$d: "; git diff dev...HEAD --name-only -- "$d" | wc -l; done
api: 0
auth: 0
cdn: 0
media: 0
messaging: 0
util: 0
types: 0
```

- ✅ 改动集合 == pa-4 scope（新增 channel/state.ts；改 engine/{wechat,sender}.ts；新增/改对应测试）。
- ✅ vendor 7 个目录（api/auth/cdn/media/messaging/util/types）**零 diff**。
- ✅ package.json / bun.lock / tsconfig.json 零 diff（未新增依赖）。
- ✅ 工作树 clean，`refactor/pa-4-channel-state` ref 与 detached HEAD 同点。

### 4. 逐条核对 pa-4.md 的 acceptance

| acceptance 条目 | 结果 | 证据 |
|---|---|---|
| typecheck + test 全绿，用例数 ≥ 基线（115）+ 新增 | ✅ | 121/14/0；见 §1、§2 |
| 新增 `src/channel/state.ts`；`rg "from \"\.\./engine" src/channel` 为空 | ✅ | 文件存在；rg 无匹配（见 §5） |
| `WechatEngine` 公共 API 逐成员不变 | ✅ | 见 §6 |
| `resetSession()` 语义与旧 `reset()` 一致（凭证/终端/计数清空，config/host/notifier 保留） | ✅ | 见 §7 |
| `sendWithRetry` 缺凭证立即抛 `"Single user not initialized"`，`outbound.sendText` 未被调用（有测试覆盖） | ✅ | 见 §8 |
| vendor 目录零 diff | ✅ | 见 §3 |
| `src/bridge/{events,commands,tool-send-file}.ts` 行为未改 | ✅ | 见 §9 |
| 提交原子、message 规范 | ✅ | 见 §10 |

### 5. `src/channel/state.ts` 与依赖方向（无 channel → engine 反向依赖）

```
$ ls -la src/channel/
-rw-r--r-- src/channel/state.ts   （仅此一文件）

$ rg -n "^import" src/channel/state.ts
import type { WechatApiOpts } from "../shared/types.js";
import type { PiHost } from "../ports/pi-host.js";

$ rg "from \"\.\./engine" src/channel
（无输出，exit 1）
```

- `ChannelState` 只承载状态 + `resetSession()`，字段为：
  `accountId` / `userId` / `contextToken` / `config` / `host` / `notifier` /
  `isTerminalMessageProcessing` / `lastRequestIdMs` / `requestIdSeq`。
- 仅 import `../shared/types`（`WechatApiOpts`）与 `../ports/pi-host`（`PiHost`）——均为类型，**无 channel → engine 反向依赖**。
- ✅ 通过。

### 6. `WechatEngine` 公共 API 逐成员比对（dev vs HEAD）

对 `/tmp/wechat.dev.ts`（`git show dev:...`）与 HEAD 提取公共成员，集合完全一致：

```
setHost / setNotifier / setConfig / configure / get connectionState
getTerminalProcessing / setTerminalProcessing / initSingleUser / stopPolling / startPolling
handleMessage / triggerAi / onAiDone / getTypingTicket / sendTypingStatus
startTypingKeepalive / stopTypingKeepalive / sendTextMessage / sendFileToUser
sendMessageWithRetry / getCurrentRequestId / isRequestProcessed / markRequestProcessed
cleanupProcessedRequests / reset
```

逐条：
- 方法名、参数、返回类型全部一致（`git diff dev...HEAD -- src/engine/wechat.ts` 中除字段迁移与 import 外无公共签名改动）。
- `setNotifier` 形参由内联 `(message, type?) => void` 改为等义别名 `Notifier`；`Notifier` 定义逐字符相同：
  `(message: string, type?: "info" | "warning" | "error") => void`，结构等价。
- `WechatHost` 由 interface 改为 `export type WechatHost = PiHost`；`PiHost` 与旧 `WechatHost` 成员签名逐条相同（appendEntry/sendUserMessage/sendMessage），结构等价，且导出名保持不变（`router.ts` 等既有 import 不受影响，typecheck 通过）。
- `WechatEnginePorts` / `WechatEngineDeps` / `setPi` / `setConfig` / `createWechatEngine` / 单例 `engine` 均未改动。
- ✅ 公共 API 不变（唯一内部变化：`private state = new ChannelState()` 取代原字段；所有读写走 `state.*`，
  `rg` 旧字段名 `singleUserId|singleContextToken|this.accountId|this.host|this.config|this.notifier|this.isTerminalMessageProcessing|this.lastRequestIdMs|this.requestIdSeq` 于 wechat.ts **无残留**）。

### 7. `resetSession()` 语义（对照旧 `reset()`）

旧 `reset()`（dev）清空：`isTerminalMessageProcessing=false`、`lastRequestIdMs=-1`、`requestIdSeq=0`、
`accountId=null`、`singleUserId=null`、`singleContextToken=null`；**不清** `config`/`host`/`notifier`；
另调 `typing.reset()`、`queue.reset()`、`poller.reset()`。

新 `reset()`（HEAD）：`typing.reset()` → `queue.reset()` → `state.resetSession()` → `poller.reset()`。
`ChannelState.resetSession()`：

```
accountId = null; userId = null; contextToken = null;
isTerminalMessageProcessing = false; lastRequestIdMs = -1; requestIdSeq = 0;
// config / host / notifier 保留
```

- ✅ 清凭证 / 终端标志 / 请求计数，保留 config/host/notifier，与旧 `reset()` 对这批字段的处理逐项一致。
- 单测 `resetSession：清空凭证/终端标志/请求计数，保留 config/host/notifier` 直接断言上述语义并通过。
- 顺序差异（新代码凭证清空在 `poller.reset()` 之前，dev 在之后）无行为影响：`PollingLoop.reset()` 不读取
  engine 的凭证字段（游标/连接状态/失败计数/abort generation 均在 `PollingLoop` 内部），见 §11 备注。

### 8. `sendWithRetry` 缺凭证前置检查（恢复 + 测试覆盖）

`src/engine/sender.ts`：

```ts
export interface SenderDeps {
  outbound: WechatOutbound;
  canSend(): boolean;            // 新增
  debug(...): void;
  error(...): void;
}

async sendWithRetry(text, maxRetries = 3): Promise<void> {
  if (!this.deps.canSend()) {
    throw new Error("Single user not initialized");   // 入口前置，先于重试循环
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) { /* ... sleep ... */ }
  throw lastError ?? new Error("sendMessage failed");
}
```

- engine 注入 `canSend: () => this.getCredentials() !== null`（`getCredentials` 要求 config + userId + contextToken 齐备）。
- 缺凭证路径：入口即抛 `"Single user not initialized"`，**不调用 `outbound.sendText`、不进入 for、不 sleep**。
- 测试 `tests/engine/engine.test.ts::sendWithRetry 缺凭证：立即抛错、不调用底层发送、不进入重试`：
  未 `initSingleUser` 时 `rejects.toThrow("Single user not initialized")`，且
  `expect(outboundMock.sendText).not.toHaveBeenCalled()`、耗时 `< 900ms`（证明未 sleep）——实测通过。
- 另一条 `sendWithRetry 凭证就绪：正常走底层发送（一次成功）` 断言 `sendText` 恰好调用 1 次且参数为 `"hello"`——实测通过。
- ✅ 通过。

### 9. bridge 行为未改 / login 无回归

```
$ git diff dev...HEAD -- src/bridge/events.ts src/bridge/commands.ts src/bridge/tool-send-file.ts
（空）
$ git diff dev...HEAD -- src/bridge/login.ts
（空）
$ git diff dev...HEAD -- src/adapters/
（空）
```

- 三个 bridge 关键文件字节级零改动；`login.ts` 本阶段零改动（PA-3 已完成端口化，PA-4 未触碰）。
- ✅ 通过。

### 10. 提交原子、message 规范

```
af2e9d6 refactor(channel): 新增 ChannelState 承载运行时会话状态
        src/channel/state.ts | 51 +                        （仅新增状态类）
99b64eb refactor(engine): 字段迁移到 ChannelState（公共 API 不变）
        src/engine/wechat.ts | 112 +-  tests/engine/engine.test.ts | 4 +-
8b20992 fix(sender): 恢复 sendWithRetry 缺凭证前置检查
        src/engine/sender.ts | 9 +   src/engine/wechat.ts | 1 +
ec14f41 test: ChannelState 与 sendWithRetry 前置检查
        tests/engine/engine.test.ts | 24 +  tests/unit/channel-state.test.ts | 98 +
```

- 4 个提交与 pa-4 建议拆分一一对应，均为 `type(scope): subject` 中文规范，单逻辑变更单提交。
- `git rev-list --count dev..HEAD` = 4；`dev` 未被改动（`git rev-parse dev` == `38270c1`，仍是 PA-3 tip）；
  仅在本地分支/游离 HEAD，未 push。
- ✅ 通过。

### 11. 关键回归语义仍覆盖（D6/D7/D9/D13/D14/D16/D16b/B5 等）

`tests/engine/engine.test.ts` 中在册并在 121 pass 中通过：

| 用例 | 行 | 状态 |
|---|---|---|
| D3 重复 startPolling 不并发 | 105 | ✅ pass |
| D9 无 AbortSignal + 300ms 快速退出（×2） | 129 / 151 | ✅ pass |
| D13 同毫秒 requestId 唯一 | 173 | ✅ pass |
| D6 sendUserMessage 抛错释放且不冒泡 | 189 | ✅ pass |
| D15 slash 判定（基线 + 非首条） | 243 / 250 | ✅ pass |
| D16 contextToken 变化重取 / 60s TTL / 报错含 ticket 清缓存（×3） | 266 / 281 / 301 | ✅ pass |
| D16b typing keepalive unref | 322 | ✅ pass |
| D7 队列排空 rejecting turn 处理 | 363 | ✅ pass |
| C9 实例隔离不污染单例 | 390 | ✅ pass |
| B4 needs_relogin 通知用户 | 417 | ✅ pass |
| B6 终端期间排队 requestId/content 一一对应 | 443 | ✅ pass |
| B5 媒体立即 ack + 后台串行（×2） | 482 / 521 | ✅ pass |

- 另 `基线：sendFileToUser 以本地文件路径提交底层发送（不再透传 fileName）`（D14）仍在并通过。
- 未发现回归用例被删除/弱化；测试迁移仅两处观测点由私有字段改走 `state.*`，断言语义不变。
- ✅ 通过。

## 备注（非阻塞观察）

1. **“对齐 dev 旧行为”的措辞**：当前 `dev`（= PA-3 tip `38270c1`）的 `sender.sendWithRetry` 本身已无入口检查（PA-3 commit `88a141e` 将其移除，改由 outbound adapter 在重试循环内抛错）。
   真正带入口前置检查的“旧实现”是 `88a141e^`（PA-3 之前）。本次恢复与 PA-3 verifier 记录一致，且完全满足 pa-4 acceptance 的显式要求（立即抛、不调用 outbound、不重试）。非缺陷，仅为溯源说明。
2. **`reset()` 内部顺序差异**：新代码 `state.resetSession()` 在 `poller.reset()` 之前，dev 将凭证清空放在 `poller.reset()` 之后。
   `PollingLoop.reset()` 不读取 engine 的凭证/config/host，纯内部状态（游标、连接、generation、失败计数），故无可观测行为差异。非缺陷。

## 判定

**PASS** — 全部 check 项通过，无阻塞问题；两处非阻塞观察不影响 acceptance。
