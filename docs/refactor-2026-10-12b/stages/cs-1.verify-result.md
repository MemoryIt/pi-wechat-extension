# CS-1 验证结果：turn 编排单一化（MessageRouter 唯一入口）

- 结论（总判定）：**PASS**
- 验证者：只读验证子 Agent
- 工作目录：`/tmp/wt-cs-1-verify`（detached HEAD）
- 被验证提交：`27e87b26e264b1a14d3d5b3bbcfeb7137b13e65d` `refactor(channel): MessageRouter 成为 turn 编排唯一入口`
- 父提交 / base：`996e347`（本地 `dev` 指向，`HEAD` 的父提交）
- 验证时间：2026-10-12
- 未做任何代码修改、提交、push、切分支

---

## 0. 逐条 check 汇总

| # | 检查项 | 结果 |
|---|--------|------|
| 1 | `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿 0 fail | **PASS** |
| 2 | `git diff dev...HEAD --stat` 未越界 | **PASS** |
| 3 | 逐条核对 `cs-1.md` acceptance 与行为契约 | **PASS** |
| 4 | 编排唯一入口：Channel 无 `TurnQueue` 字段 / 队列迁移只在 router | **PASS** |
| 5 | `MessageRouter` 提供 `dispatch` / `onTurnDone`，语义等价原 `triggerAi` / `onAiDone` | **PASS** |
| 6 | 文本路径：`appendEntry(wechat_meta)` + `sendUserMessage`，成功后保持 busy（D1） | **PASS** |
| 7 | 错误路径：不冒泡、释放忙闲、`markRequestProcessed`、必要时排空 | **PASS** |
| 8 | 媒体路径：ack 失败隔离（F6 "Media ack failed"）、后台队列、mark、不占忙闲 | **PASS** |
| 9 | `Channel` 公共方法与四个窄接口契约不变 | **PASS** |
| 10 | tests diff 审计（ledger、断言强度未削弱） | **PASS** |
| 11 | src↔tests 交叉核对（被改公共方法/类有测试覆盖） | **PASS** |
| 12 | vendor 零 diff、无新依赖 | **PASS** |
| 13 | 提交原子、message 规范、未 push | **PASS** |

---

## 1. 命令与计数（check #1）

命令：`bun install --frozen-lockfile && bun run typecheck && bun run test`

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
+ @earendil-works/pi-coding-agent@0.84.4
+ @types/node@25.9.8
+ @types/qrcode-terminal@0.12.2
+ typescript@5.9.3
+ @sinclair/typebox@0.34.52
+ qrcode-terminal@0.12.0
+ zod@4.3.6
130 packages installed [165.00ms]

$ bun run typecheck    # tsc --noEmit
TYPECHECK_EXIT=0       # 零错误

$ bun run test         # bun test --isolate
 176 pass
 0 fail
 511 expect() calls
Ran 176 tests across 20 files. [982.00ms]
TEST_EXIT=0
```

- typecheck：`0` 错误（独立捕获 tsc 退出码 = 0）。
- test：`176 pass / 0 fail / 20 files / 511 expect()`，退出码 0。
- baseline：`171 pass / 20 files / 0 fail`；本阶段 `+5`（新增 5 个用例），0 fail，满足硬底线；数量为上升，符合“不以数量为通过条件”。

> 备注（非回归）：若**不带** `--isolate` 只跑被改的三个测试文件，会出现 2 个
> `SyntaxError: export 'setLogLevel' not found in '../../util/logger.js'` —— 这是
> `tests/README.md` 明确记载的 `mock.module` 进程全局污染，官方脚本固定用
> `--isolate`；带 `--isolate` 单跑这三个文件为 `44 pass / 0 fail`。与本次改动无关。

---

## 2. 变更范围（check #2）

`git diff dev...HEAD --stat`：

```
 src/channel/channel.ts                 | 36 +++++-----------
 src/channel/router.ts                  | 61 ++++++++++++++++++++++----
 tests/channel/channel.test.ts          | 12 +++---
 tests/channel/router.test.ts           | 78 +++++++++++++++++++++++++++++++++-
 tests/integration/channel-flow.test.ts |  4 +-
 5 files changed, 148 insertions(+), 43 deletions(-)
```

- 仅涉及 `src/channel/{channel,router}.ts`、`tests/channel/**`、`tests/integration/**`，**未越界**。

---

## 3. 编排唯一入口（check #4）

```
$ rg -n "TurnQueue" src/channel/channel.ts
(none)
$ rg -n "setBusy|setCurrentRequestId|\.drain\(" src/channel/channel.ts
(none)
$ rg -n "setBusy|setCurrentRequestId|\.drain\(|\.enqueue\(" src/ --glob '*.ts'
src/channel/router.ts:56   queue.enqueue({ msg, requestId });
src/channel/router.ts:71   queue.setBusy(false);
src/channel/router.ts:72   queue.setCurrentRequestId(null);
src/channel/router.ts:75   void this.drain();
src/channel/router.ts:104  mediaQueue.enqueue(() => this.processMediaInBackground(...));
src/channel/router.ts:111  this.drain();
src/channel/router.ts:117  queue.setCurrentRequestId(requestId);
src/channel/router.ts:118  queue.setBusy(true);
src/channel/router.ts:150  queue.setBusy(false);
src/channel/router.ts:151  queue.setCurrentRequestId(null);
src/channel/router.ts:153  void this.drain();
src/channel/router.ts:172  queue.setBusy(false);
src/channel/router.ts:182  queue.setBusy(false);
src/channel/router.ts:183  if (queue.size > 0) void this.drain();
src/channel/router.ts:192  queue.setBusy(false);
src/channel/router.ts:193  queue.setCurrentRequestId(null);
src/channel/router.ts:194  if (queue.size > 0) void this.drain();
src/channel/queue.ts:26    setBusy(value: boolean): void {        # 定义
src/channel/queue.ts:34    setCurrentRequestId(id: string|null)  # 定义
```

- `Channel` 不再声明 `TurnQueue` 字段（`private readonly queue` 已删除）。
- 所有队列状态迁移（`setBusy` / `setCurrentRequestId` / `drain` / `enqueue`）在 **prod 中仅出现在 `router.ts`**（`queue.ts` 为定义处）。
- `Channel` 对队列的接触仅剩公开防重方法的委托：`this.router.queue.*`（`getCurrentRequestId/isRequestProcessed/markRequestProcessed/reset`），无状态改写。

---

## 4. dispatch / onTurnDone 语义等价（check #5）

`src/channel/channel.ts` 新实现：

```ts
async triggerAi(msg, requestId, opts) { await this.router.dispatch(msg, requestId, opts); }
onAiDone() { this.router.onTurnDone(); }
```

`router.dispatch` 与原 `Channel.triggerAi` 逐字对应：

```ts
// 原 Channel.triggerAi：                      // 新 MessageRouter.dispatch：
if (queue.isBusy() || state.isTerminal...) {   if (queue.isBusy() || this.deps.isTerminalProcessing()) {
  queue.enqueue({ msg, requestId });             queue.enqueue({ msg, requestId });
  logger.debug(`AI is ${...}, queued ...`);      logger.debug(`AI is ${...}, queued ...`);
  return;                                        return;
}                                              }
await this.router.execute(...);               await this.execute(...);
```

`router.onTurnDone` 与原 `Channel.onAiDone` 逐字对应：

```ts
queue.setBusy(false);
queue.setCurrentRequestId(null);
if (queue.size > 0) { void this.drain(); }
```

- `RouterDeps.queue` 改为可选，缺省 `new TurnQueue(...)` 自建；`MessageRouter` 暴露 `readonly queue`。构造处 `this.queue = deps.queue ?? new TurnQueue(...)`；无其它 `deps.queue` 引用。
- `RouterDeps` 新增 `isTerminalProcessing(): boolean`，`Channel` 注入 `() => this.state.isTerminalMessageProcessing`。

---

## 5. 四条路径 + D1/F6（check #6/7/8）

源码（`src/channel/router.ts`）：

- **文本**（L113–142）：`queue.setCurrentRequestId(requestId)` + `setBusy(true)` → `host.appendEntry("wechat_meta", { requestId })` → `host.sendUserMessage(content, { deliverAs: "followUp" })` → `handedOffToAgent = true`；`finally` 中成功路径不释放，**保持 busy** 等 `onTurnDone`（D1）。
- **错误**（L137–155）：`catch` 记 `execute failed`，`queue.markRequestProcessed(requestId)`；`finally` 中 `!handedOffToAgent` → `setBusy(false)` + `setCurrentRequestId(null)` + 有排队则 `drain()`。不冒泡。
- **媒体**（L90–112）：`hasMedia && !hasText` → `try { await sender.sendText("媒体文件已收到，正在保存…") } catch { logger.error("Media ack failed (requestId=...)") }`（F6 隔离，不抛）→ `mediaQueue.enqueue(...)` → `queue.markRequestProcessed(requestId)` → 不占用忙闲 → 有排队则 `drain()`。
- **drain**（L163–195）：`await sleep(20)`；空队列 → `setBusy(false)`；否则 `dequeue().execute()`；`execute` rejection 被 catch 并释放状态（D1）。

对应测试（`tests/channel/router.test.ts`，均通过）：

```
(pass) router.dispatch 空闲：直接调用 execute（宿主收到消息）      # appendEntry + sendUserMessage + busy/currentRequestId=D1
(pass) router.dispatch 忙：入队不执行
(pass) router.dispatch 终端处理中：入队不执行
(pass) router.onTurnDone：清 busy/currentRequestId；有排队则排空队首
(pass) router.onTurnDone：空队列仅释放忙闲，不再执行
(pass) router.execute 文本：appendEntry + sendUserMessage，成功后保持 busy
(pass) router.execute 文本：host 缺失时释放忙闲并标记处理完成
(pass) router.execute 文本：sendUserMessage 同步抛错不冒泡且释放忙闲
(pass) router.execute 媒体：立即 ack、入后台队列、不占用忙闲
(pass) F6 目标：媒体 ack 失败不抛，仍标记处理并照常入后台队列    # 断言 loggerErrors 含 "Media ack failed"
(pass) router.drain：空队列直接释放忙闲 / 取队首执行 / rejection 被捕获 / config 缺失释放
```

集成层（`tests/integration/channel-flow.test.ts`）亦覆盖“文本 busy 保持 → 第二条入队 → `onAiDone` 释放并排空”。

其它契约：D2 `markRequestProcessed` 成功文本路径仍由 `ReplyService` 调用（`src/application/reply.ts` 未被 diff）；D13 `requestId` 生成仍在 `Channel.generateRequestId()`（`channel.ts:198,364`）。

---

## 6. Channel 公共 API / 窄接口（check #9）

`dev` 与 `HEAD` 的 `Channel` 公共方法名与顺序完全一致（仅行号偏移）：

```
constructor, setHost, setNotifier, setConfig, get connectionState,
getTerminalProcessing, setTerminalProcessing, initSession, stopPolling, startPolling,
handleMessage, triggerAi, onAiDone, getTypingTicket, sendTypingStatus, startTyping,
stopTyping, sendText, sendFile, sendReply, getCurrentRequestId, isRequestProcessed,
markRequestProcessed, reset
```

- `triggerAi` / `onAiDone` / `getCurrentRequestId` / `isRequestProcessed` / `markRequestProcessed` / `reset` 签名未变，语义未变（内部委托 router）。
- 四个窄接口定义文件均在 forbidden 区域、**未被 diff**：`application/types.ts`(ReplyChannel)、`application/session.ts`(SessionChannel)、`bridge/events.ts`(BridgeChannel)、`bridge/tool-send-file.ts`(SendFileChannel)；`bun run typecheck` 通过即结构兼容成立。

---

## 7. tests/ diff 审计 ledger（check #10）

**无任何用例被删除**（test 声明数 `dev=171 → HEAD=176`，`+5` 全为新增）。

| 文件 | 变更 | 去向分类 | 说明 |
|------|------|----------|------|
| `tests/channel/channel.test.ts` | 5 处 `c.queue` → `c.router.queue` | **迁移** | 仅观察路径随队列所有权迁移；断言与期望值逐字未变 |
| `tests/channel/router.test.ts` | harness 签名补 `isTerminalProcessing`；新增 3 个 `dispatch` + 2 个 `onTurnDone` 用例 | **迁移 + 新增** | 新公共入口的行为覆盖 |
| `tests/integration/channel-flow.test.ts` | 2 处 `queue` → `router.queue` | **迁移** | 同 channel.test.ts |

断言强度核验（`expect(` 计数，dev → HEAD）：

```
tests/channel/channel.test.ts:        66 → 66   （不变）
tests/channel/router.test.ts:         41 → 61   （+20，全部来自新增用例）
tests/integration/channel-flow.test.ts: 32 → 32 （不变）
```

修改行**均为 1:1 访问路径替换**，无 `toBe→toBeTruthy`、无删 `expect`、无放宽精确值。

抽查 ≥2 条（原文对照，dev → HEAD，断言等价）：

1. `channel.test.ts` D6：
   - dev：`expect((channel as unknown as AnyChannel).queue.isBusy()).toBe(false);`
   - HEAD：`expect((channel as unknown as AnyChannel).router.queue.isBusy()).toBe(false);`
2. `channel.test.ts` B6：`c.queue.size` → `c.router.queue.size`，期望仍为 `toBe(3)` / `toBe(0)`，`requestIds`/`contents` 精确数组断言未变。
3. `integration/channel-flow.test.ts`：`...queue.size` → `...router.queue.size`，期望仍为 `toBe(1)`；`getCurrentRequestId()` 断言不变。

---

## 8. src↔tests 交叉核对（check #11）

| 被改公共方法/类 | 测试去向 | 覆盖情况 |
|-----------------|----------|----------|
| `MessageRouter.dispatch` | `router.test.ts` 3 用例（空闲执行 / 忙入队 / 终端入队） | ✅ |
| `MessageRouter.onTurnDone` | `router.test.ts` 2 用例（释放+排空 / 空队列） | ✅ |
| `MessageRouter.queue`（公开只读） | `router.test.ts` 全部用例经 `h.queue` 观察；channel 经 `router.queue` | ✅ |
| `RouterDeps.isTerminalProcessing`（新增必填） | `makeHarness` 注入；`dispatch 终端处理中` 用例 | ✅ |
| `RouterDeps.queue`（改可选） | 缺省自建路径由 `makeHarness` 显式注入覆盖；Channel 生产路径不注入 | ✅ |
| `Channel.triggerAi`→`dispatch` | `channel.test.ts` D6/D7/B6、`channel-flow` 入站文本 | ✅ |
| `Channel.onAiDone`→`onTurnDone` | `channel.test.ts` D7/B6、`channel-flow` | ✅ |
| `Channel.getCurrentRequestId/isRequestProcessed/markRequestProcessed`→委托 | `channel-flow` L127/132/139、`channel.test.ts` 防重用例 | ✅ |

`new MessageRouter` 生产调用只有 `channel.ts:102`（不传 queue → 自建），测试在 `router.test.ts:69`，无遗漏构造点。

---

## 9. vendor / 依赖（check #12）

```
$ git diff dev...HEAD --stat -- api auth cdn media messaging util types \
    src/ports src/adapters src/application src/bridge src/shared src/storage src/index.ts
(空)
$ git diff dev...HEAD -- package.json bun.lock
(空)
```

- vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）与 forbidden 的 `src/ports|adapters|application|bridge|shared|storage|index.ts` **零 diff**。
- `package.json` / `bun.lock` 零 diff → **无新依赖**。

---

## 10. 提交（check #13）

```
$ git log dev..HEAD --format='%H %s'
27e87b26e264b1a14d3d5b3bbcfeb7137b13e65d refactor(channel): MessageRouter 成为 turn 编排唯一入口
```

- **原子**：`HEAD` 相对 `dev` 仅 1 个提交；父提交 `996e347`；`git show --stat` 仅含 5 个预期文件。
- **message 规范**：`refactor(channel): ...`，body 分条描述改动与测试迁移，符合约定。
- **未 push**：`git branch -a --contains HEAD` 无任何 `origin/*`；`git ls-remote origin` 的 `refs/heads/dev|main` 均为 `a5069b4`，不含 `27e87b2`；本地无 remote tracking 分支指向它。
- **未改 base**：本地 `dev` 仍为 `996e347`，`git merge-base --is-ancestor HEAD dev` 为假（HEAD 不是 dev 祖先）。

---

## 11. 最终判定

**PASS** —— 13 项检查全部通过；CS-1 的 acceptance 与行为契约逐条满足：`MessageRouter` 成为 turn 编排唯一入口，队列状态迁移集中，`Channel` 公共 API / 窄接口 / vendor / 依赖 / 文案 / 持久化均未变，测试全绿 0 fail 且无断言削弱，提交原子规范且未 push。
