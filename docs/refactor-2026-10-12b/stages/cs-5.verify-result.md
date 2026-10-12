# CS-5 验证报告（只读子 Agent）

- 工作目录：`/tmp/wt-cs-5-verify`（detached HEAD @ `75ff996`）
- 分支：`refactor/cs-5-inbound-handler`
- base：`dev` = `acfab37`（`git merge-base --is-ancestor dev HEAD` 成功，dev 为 HEAD 祖先）
- 结论：**PASS**（12 项 check 全过；2 处既有文档陈旧引用作为备注，不影响验收）

---

## 1. 全绿门禁（install / typecheck / test）

命令（一次性串行，`CHAIN_EXIT=0`）：

```
$ bun install --frozen-lockfile && bun run typecheck && bun run test

$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
+ @earendil-works/pi-coding-agent@0.84.4 ... 130 packages installed [237.00ms]
（lockfile 无变更，git status 之后仍 clean）

$ bun run typecheck
$ tsc --noEmit
（无输出）

$ bun run test         # = bun test --isolate
 194 pass
 0 fail
 593 expect() calls
Ran 194 tests across 23 files. [961.00ms]

CHAIN_EXIT=0
```

- 基线（cs-4.result）`188 pass / 22 files / 0 fail / 556 expect`；当前 `194 / 23 / 0 / 593`。
- 硬底线「全绿 / 0 fail / typecheck 零错误」→ **满足**。
- 计数变化方向合理：新增 `inbound-handler.test.ts` 7 用例（+38 expect），删除 D13（−1 用例 / −1 expect），净 +6 用例 / +1 文件 / +37 expect。
- **判定：PASS**

## 2. 越界检查（`git diff dev...HEAD --stat`）

```
 src/channel/channel.ts                |  48 +++----
 src/channel/inbound-handler.ts        |  78 ++++++++++++
 tests/channel/channel.test.ts         |  23 +---
 tests/channel/inbound-handler.test.ts | 234 ++++++++++++++++++++++++++++++++++
 4 files changed, 331 insertions(+), 52 deletions(-)
```

仅 `src/channel/{inbound-handler,channel}.ts` 与 `tests/channel/**`。**PASS**

额外证据（以下 `git diff dev...HEAD --stat -- <path>` 全部为空）：
- vendor：`api/ auth/ cdn/ media/ messaging/ util/ types/` → 空
- 新增依赖：`package.json` / `bun.lock` → 空；未新增依赖
- 禁止目录：`src/ports src/adapters src/application src/bridge src/shared src/storage src/index.ts` → 空
- 其它 `src/channel/*.ts`（inbound-parser / media-store / polling / queue / request-id / router / sender / state / typing / credential-loader）→ 空
- **判定：PASS**

## 3. cs-5.md acceptance 与「行为契约」逐条核对

| acceptance / 契约 | 证据 | 判定 |
|---|---|---|
| 全绿 / 0 fail / typecheck 0 错 | §1 | PASS |
| 新增 `inbound-handler.ts`，导出 `InboundHandler` + 工厂 | `export class InboundHandler`、`export function createInboundHandler`、`export interface InboundHandlerDeps/InboundTyping/InboundDispatch` | PASS |
| `poller.onMessage` 指向 `inboundHandler.handle` | `channel.ts:135` = `onMessage: (msg, opts) => this.inboundHandler.handle(msg, opts)`；`rg this\.handleMessage src/` 无命中 | PASS |
| `handleMessage`/`triggerAi` 为委托、签名不变 | `channel.ts:197-199` `handleMessage` → `return this.inboundHandler.handle(msg, opts)`；`channel.ts:204-207` `triggerAi` → `await this.router.dispatch(...)`，签名逐字不变 | PASS |
| `Channel` 无 `requestId` 字段 / `generateRequestId` | `rg generateRequestId src/` 无命中；`channel.ts` 中仅剩构造 InboundHandler 的 `requestId: new RequestIdGenerator()` 与 `triggerAi`/防重 API 的参数名，无 `private readonly requestId` 字段 | PASS |
| 行为契约逐条一致（顺序/条件持久化/分支） | §7 归一化 diff + §9 新用例；顺序断言 `["requestId","debug","invalidateTicket","saveContextToken","dispatch"]` | PASS |
| `Channel` 其余公共 API / 文案 / 持久化 / 端口签名不变 | §8 | PASS |
| diff 仅限指定文件 | §2 | PASS |
| ledger 完整、无削弱断言 | §9 | PASS |
| 提交原子、message 规范、未 push | §12 | PASS |

**判定：PASS**

## 4. 新文件独立性 / 依赖方向

`src/channel/inbound-handler.ts` 全部 import（逐字 6 条，与任务书允许集合完全一致）：

```
import type { WeixinMessage } from "../ports/types.js";
import type { WechatApiOpts } from "../shared/types.js";
import * as storage from "../storage/state.js";
import type { ChannelState } from "./state.js";
import type { RequestIdGenerator } from "./request-id.js";
import type { PluginLogger } from "../shared/logger.js";
```

- 恰好 `ports/types`、`shared/types`、`storage/state`、`./state`、`./request-id`、`shared/logger`；无 `Channel` / vendor / engine / 适配层依赖。**PASS**

## 5. 两个 poller 回调均不再指回 Channel

`src/channel/channel.ts:130,135`：

```ts
ensureSession: () => this.credentialLoader.ensureSession(),   // cs-4 已解除
onMessage: (msg, opts) => this.inboundHandler.handle(msg, opts), // cs-5 解除
```

- `rg "this\.handleMessage" src/` → 无命中。
- `rg "this\.initSession" src/` → 无命中。
- 两个构造期回调目标分别是协作者对象 `credentialLoader` / `inboundHandler` 的方法，不再是 Channel 方法。**PASS**

## 6. handleMessage / triggerAi 委托 + requestId 字段/生成器移除

- `handleMessage`：`return this.inboundHandler.handle(msg, opts);`（`channel.ts:198`），签名 `(msg: WeixinMessage, opts: WechatApiOpts): Promise<void>` 不变。
- `triggerAi`：`await this.router.dispatch(msg, requestId, opts);`（`channel.ts:206`），签名 `(msg, requestId, opts): Promise<void>` 不变。
- `rg generateRequestId src/` → 无命中；`rg "private readonly requestId" src/` → 无命中。`RequestIdGenerator` 仍被 import，仅用于构造 InboundHandler 时注入匿名实例。**PASS**

## 7. 行为契约「逐字等价」（方法体归一化 diff）

把旧 `Channel.handleMessage` 主体与新的 `InboundHandler.handle` 主体抽出，仅对合理的名称映射做归一化
（`this.deps.`→`this.`、`this.requestId.next()`→`this.generateRequestId()`、`this.router.dispatch(`→`this.triggerAi(`）后 diff：

```
$ git show dev:src/channel/channel.ts | sed -n '/async handleMessage/,/^  }$/p' | sed '1d;$d' > /tmp/old_handle.txt
$ sed -n '/async handle(msg/,/^  }$/p' src/channel/inbound-handler.ts | sed '1d;$d' > /tmp/new_handle.txt
$ diff /tmp/old_handle.txt <(normalized new)
（无差异）
SEMANTICALLY IDENTICAL (normalized)
```

逐条核对契约：

1. `const requestId = ...next();` 在所有副作用之前生成。✓
2. `if (msg.context_token && msg.context_token !== state.contextToken)` 条件不变。✓
3. 变化分支顺序：`logger.debug("Updating contextToken from message")` → `state.contextToken = msg.context_token` → `typing.invalidateTicket()` → 仅当 `state.accountId && state.userId` → `await storage.saveContextToken(accountId, userId, { displayName: userId, contextToken: msg.context_token, lastMessageAt: Date.now() })`。✓
4. 缺失/空串/相同：零副作用，仍 dispatch。✓
5. 最终 `router.dispatch(msg, requestId, opts)`（旧的 `this.triggerAi` 主体即 `router.dispatch`，等价）。✓

**判定：PASS**

## 8. Channel 其余公共方法 / 四个窄接口

- `git diff dev...HEAD -- src/channel/channel.ts` 中除注释、import、字段、构造函数、`onMessage`、`handleMessage` 体内、`generateRequestId` 删除外，无任何方法签名改动；`triggerAi` / `onAiDone` / typing / sender / 防重 / reset 全部逐字保留。
- 四个窄接口（`docs/ARCHITECTURE.md` 定义）所需方法在 Channel 中全部存在且签名不变：
  - `BridgeChannel`（`bridge/events.ts`）：`setNotifier` / `setTerminalProcessing` / `startTyping` / `stopTyping` ✓
  - `ReplyChannel`（`application/types.ts`）：`isRequestProcessed` / `stopTyping` / `sendReply` / `markRequestProcessed` / `setTerminalProcessing` / `onAiDone` ✓
  - `SessionChannel`（`application/session.ts`）：`connectionState` / `setConfig` / `startPolling` / `stopPolling` / `reset` ✓
  - `SendFileChannel`（`bridge/tool-send-file.ts`）：`sendFile` ✓
- 这些接口定义文件均在 diff 之外（零改动）；全仓 `tsc --noEmit` 零错误，结构化赋值兼容性成立。
- 端口文件 `src/ports/**` 零 diff，`ChannelPorts` / `ChannelDeps` 未改。**PASS**

## 9. tests/ diff 审计（迁移 / 被蕴含 / 失效）

`git diff dev...HEAD -- tests/` 仅两处：

**(a) `tests/channel/channel.test.ts`（修改，+23/-20）**
- 删除的唯一用例 = D13 `"D13 目标：同一毫秒内的 requestId 应保持唯一"`（原经 `(channel as AnyChannel).generateRequestId()`）。
- 同批删除仅：文件头 D13 注释行 + 失效的 `import { setSystemTime } from "bun:test"`（该文件不再使用）。
- `git diff dev...HEAD -- tests/channel/channel.test.ts | rg '^-[^-]'` 逐行确认：删除内容仅上述 D13 用例与其注释/import；**其余既有用例零修改、零删除、零削弱**。

**D13「被蕴含（subsumed）」判定 —— 成立**：
- 迁出后 `Channel.generateRequestId` / `Channel.requestId` 已不存在，原用例引用的私有成员消失（属「失效」），任务书允许「迁移或删除并记被蕴含」二选一。
- 其不变量「同一毫秒内唯一」由 `tests/channel/request-id.test.ts` 确定性且更强地覆盖：
  - `同毫秒连续两次：id 不同且后缀按 000/001 递增` → `expect(a).not.toBe(b)` + `a.endsWith("000")` + `b.endsWith("001")`；
  - `同毫秒多次：序号继续递增且保持唯一` → `new Set(ids).size === 3` + 后缀 000/001/002；
  - `now 变化：序号归零`；`id 格式：15 位时间戳 + 3 位序号，总长 18`（正则 + 精确前缀）。
  - 旧 D13 只断言 `a !== b`；新覆盖额外断言序号、跨毫秒归零、长度/格式，**覆盖面不缩小、强度更高**。
- 本阶段新增 `inbound-handler.test.ts` 第 1 例进一步断言 `requestId.next()` 恰调用 1 次且 `dispatch` 收到该 id。

**(b) `tests/channel/inbound-handler.test.ts`（新增，234 行 / 7 用例 / 38 expect）**
- 覆盖 test-plan：变化+凭证齐全（精确 state/invalidateTicket/debug 文案/`saveContextToken` 精确参数/顺序）✓；变化+userId 缺失 ✓；变化+accountId 缺失 ✓；缺失 ✓；空串 ✓；与当前相同 ✓；工厂 `createInboundHandler` ✓。

**断言强度抽查（≥2 条）**：
- 用例 1：`expect(h.state.contextToken).toBe("CTX-NEW")`、`toHaveBeenCalledTimes(1)`、`toHaveBeenCalledWith("Updating contextToken from message")`、`toHaveBeenCalledWith("acc1","U1",{displayName:"U1",contextToken:"CTX-NEW",lastMessageAt:NOW})`、`toHaveBeenCalledWith(msg,"REQ-1",OPTS)`、`expect(h.order).toEqual([...])` —— 精确值 / 精确次数 / 精确参数 / 精确顺序数组。
- 用例「缺失」：`.not.toHaveBeenCalled()` × 3、`.not.toHaveBeenCalled()` for debug、`toEqual(["requestId","dispatch"])` —— 全为强断言。
- 弱断言扫描（本阶段新增/修改测试）：`toBeTruthy|toBeFalsy|toBeDefined|toBeGreaterThan|toBeLessThan` 仅出现在未被本阶段修改的既有用例，未用于新断言。

**判定：PASS**

## 10. src↔tests 交叉核对

- `inbound-handler` 新行为有独立用例：`tests/channel/inbound-handler.test.ts`（`bun test --isolate` 单跑 3 文件 = 33 pass / 0 fail / 119 expect，见 §1 与下方）。
- `channel.test.ts` 的 handleMessage/triggerAi 用例仍覆盖委托路径：
  - `handleMessage`：D6（`channel.test.ts:234`）、CS-3 `"/foo"`（`:288`）、媒体 ack（`:527,562,563`）。
  - `triggerAi`：D7（`:409`）、C9（`:435`）、B6（`:482-484`）。
  - 集成测试 `tests/integration/channel-flow.test.ts` 4 处 `channel.handleMessage` 原样通过。
- 定向隔离运行：
  ```
  $ bun test --isolate tests/channel/inbound-handler.test.ts tests/channel/channel.test.ts tests/channel/request-id.test.ts
   33 pass / 0 fail / 119 expect() calls
  ```
- 说明：`inbound-handler.test.ts` 用 `mock.module(storage/state.js)` 注入 fake；**必须**经 `bun test --isolate`（即 npm script `bun run test`）运行。不带 `--isolate` 直跑多文件会因模块 mock 泄漏导致其它文件失败——这不是本阶段缺陷，而是既有测试基础设施约定（`package.json` test = `bun test --isolate`），全量门禁已按要求命令验证通过。**PASS**

## 11. vendor 零 diff / 无新依赖

- `git diff dev...HEAD -- api/ auth/ cdn/ media/ messaging/ util/ types/` → 空。
- `git diff dev...HEAD -- package.json bun.lock` → 空；`bun install --frozen-lockfile` 后工作树仍 clean。**PASS**

## 12. 提交原子性 / message / 未 push

- `git rev-list --count dev..HEAD` = `1`；commit `75ff996` message：
  `refactor(channel): 抽出入站处理器 InboundHandler，打破 poller 回调闭环` —— 符合 `refactor(channel): ...` 规范。
- 该提交恰含 4 文件（channel.ts + 新增 inbound-handler.ts + channel.test.ts D13 处理 + 新增 inbound-handler.test.ts），单一逻辑。
- 未 push：`git branch -r | rg 'cs-5|refactor'` 无输出（远端无该分支）；HEAD detached，无 upstream；工作树 clean，未切分支、未改 dev、未执行任何写操作。**PASS**

---

## 附：备注（不影响验收）

1. **既有文档陈旧引用（本阶段 diff 范围外，按 scope 不应修改）**：
   - `docs/ARCHITECTURE.md:144` 仍写「`Channel` 私有 `generateRequestId()` 委托 `requestId.next()`」，CS-5 后应为 `InboundHandler` 持有生成器。
   - `tests/README.md:81` 的 D13 行仍指向 `tests/channel/channel.test.ts`，实际不变量现由 `tests/channel/request-id.test.ts` 覆盖。
   二者均为后续文档/清理阶段事项；因 CS-5 scope 限定 `git diff` 仅 4 个文件，未修改是正确的。
2. 未发现任何越界、断言削弱、vendor/依赖改动或 push。

## 最终判定：**PASS**
