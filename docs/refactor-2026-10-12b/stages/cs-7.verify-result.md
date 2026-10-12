# CS-7 Verify Result（只读验证）

- worktree: `/tmp/wt-cs-7-verify`
- ref: `4054286`（detached，`refactor/cs-7-facade-narrowing` 同 SHA）
- base: `dev` = `47641b1`（HEAD 的父提交；`git log dev..HEAD` 仅本阶段 1 commit）
- 模式: 只读（未修改代码 / 未提交 / 未 push / 未切换分支）
- 结论: **PASS**（全部 check 通过）

---

## check 1 — tests / typecheck 全绿

命令：`bun install --frozen-lockfile && bun run typecheck && bun run test`

```
bun install v1.4.2 ... 130 packages installed [208.00ms]   # frozen-lockfile 未改动 lockfile
$ tsc --noEmit                                             # 退出码 0，零错误
 194 pass
 0 fail
 593 expect() calls
Ran 194 tests across 24 files. [981.00ms]
```

- 基线：194 pass / 23 files / 0 fail。当前：194 pass / **24 files** / 0 fail（+1 文件=新增 `typing.test.ts`，pass 与 expect 持平）。
- install / typecheck exit code 0。**PASS（全绿、0 fail）**

## check 2 — diff 未越界

`git diff dev...HEAD --name-status`：

```
M  src/channel/channel.ts
M  tests/channel/channel.test.ts
A  tests/channel/typing.test.ts
M  tests/integration/channel-flow.test.ts
```

仅上述 4 个文件，全部落在允许范围（`src/channel/channel.ts`、`tests/channel/**`、`tests/integration/**`）。
`package.json` / `bun.lock` 零 diff；vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）、
`src/ports|adapters|application|bridge|shared|storage`、`src/index.ts`、其它 `src/channel/*.ts` 均零 diff。**PASS**

## check 3 — 逐条核对 cs-7.md acceptance 与行为契约

见下方各条。行为契约（5 方法纯转发、迁移语义、requestId 观察语义）均满足。**PASS**

## check 4 — channel.ts 内 5 方法无命中

```
$ rg -n "getTerminalProcessing|getTypingTicket|sendTypingStatus|getCurrentRequestId|sendText" src/channel/channel.ts
exit=1   # 无命中
```

**PASS**

## check 5 — 5 个被删方法在 src/ 中确无生产调用

`rg` 复核 `src/` 中的相关名字命中，全部指向**端口/协作类对象**，无一处对 `Channel` 实例的调用：

| 名字 | src 命中 | 对象 |
|---|---|---|
| `getTerminalProcessing` | 无 | — |
| `getTypingTicket` | `src/channel/typing.ts:55` `this.deps.outbound.getTypingTicket()` | **端口** `WechatOutbound`，非 Channel |
| `sendTypingStatus` | `src/channel/typing.ts` 仅日志文案 | 文案，非方法调用 |
| `sendText` | `src/channel/sender.ts:33` `outbound.sendText()`、`:74` `this.sendText()`（MessageSender 内）；`src/channel/router.ts:97` `this.deps.sender.sendText()` | **sender/outbound**，非 Channel |
| `getCurrentRequestId` | `src/channel/queue.ts:30`（方法定义） | **MessageQueue**，非 Channel |

`channel.ts` 外无任何 `.getTypingTicket/.sendTypingStatus/.getCurrentRequestId/.getTerminalProcessing/`
对 `Channel` 实例的调用（`channel.` 前缀命中为 0）。**PASS**

## check 6 — 新增 `typing.test.ts` 直接测 `TypingController`，覆盖原 D16 三条语义

`bun test tests/channel/typing.test.ts`：

```
(pass) typing：contextToken 变化后应重新获取 ticket（原 D16-1）
(pass) typing：ticket 缓存 60s TTL 内命中、过期后重新获取（原 D16-2）
(pass) typing：sendStatus 报错含 'ticket' 时清空缓存并重新获取（原 D16-3）
 3 pass / 0 fail / 11 expect() calls
```

- 直接构造 `TypingController({ outbound, getContextToken, debug, error })`（`src/channel/typing.ts`），
  注入 fake `outbound` 与可变 `getContextToken`。
- D16-1：token 变更后 `getTypingTicket` 重新取（`toBe T1/T2` + `toHaveBeenCalledTimes(2)`）。
- D16-2：TTL 内命中（`toHaveBeenCalledTimes(1)`）、`Date.now` 覆盖 +61s 后重取（`toHaveBeenCalledTimes(2)`）。
- D16-3：`sendTyping` 报错含 `"ticket"` → 清缓存 → `getTicket` 重取（`toHaveBeenCalledWith(1,"T1")`、
  `getTypingTicket` `toHaveBeenCalledTimes(2)`）。
- 三条用例均用精确 `toBe` / `toHaveBeenCalledWith` / `toHaveBeenCalledTimes`。**PASS**

## check 7 — channel.test.ts：D16 三例删除、D16b 保留、其余未削弱

- diff 仅：头部注释更新 + 删除 D16 三例（`channel.getTypingTicket` / `channel.sendTypingStatus` 观测）。
- D16b（`typing keepalive 的 interval 应调用 unref`）保留在 `channel.test.ts:311`，`startTyping`/`stopTyping` 未删。
- 其余测试无任何改动。**PASS**

## check 8 — integration requestId 观察语义等价

`tests/integration/channel-flow.test.ts` 改写：

| 原断言 | 现断言 | 语义 |
|---|---|---|
| `toEqual({ requestId: channel.getCurrentRequestId() })` | `recordedRequestId === queue.getCurrentRequestId()`（`toBe`） | 本轮 requestId 一致 |
| `channel.getCurrentRequestId()).not.toBeNull()` | `queue.getCurrentRequestId()).not.toBeNull()` | 当前 turn 非空 |
| `channel.getCurrentRequestId()).toBeNull()` | `queue.getCurrentRequestId()).toBeNull()` | onAiDone 后排空 |

其中 `queue` 经既有字段路径 `(channel as ...).router.queue` cast 观察（仅测试内部）。
`recordedRequestId` 取自 `appendEntry[0][1].requestId`，与 queue 当前值精确比较。**PASS**

## check 9 — 审计 tests/ diff 与断言强度抽查（≥2 条）

- D16 三例去向 = **迁移**（非删除/失效），见 check 6；ledger 已写入 `/tmp/pi-tasks/cs-7.result.md`。
- 集成测试 3 处 = **等价改写**（相等 / 非空 / null），无放宽。
- 抽查 ≥2 条断言强度：
  1. **D16-2**：原 `expect(await getTypingTicket()).toBe("T1")` ×2、`toHaveBeenCalledTimes(1)`、
     过期后 `toBe("T2")`、`toHaveBeenCalledTimes(2)` → 新用例逐条保留，无 `toBeTruthy` 替换。
  2. **集成相等断言**：原 `toEqual({requestId})` → 现 `expect(recordedRequestId).toBe(queue.getCurrentRequestId())`，
     由结构相等改为精确 `toBe`，强度不降。
  3. **D16-3**：`toHaveBeenCalledWith(1,"T1")` 与最终 `toHaveBeenCalledTimes(2)` 原样保留。
- 无 `toBe→toBeTruthy`、无删 `expect`、无放宽精确值。**PASS**

## check 10 — src↔tests 交叉核对

- `rg "channel\.(getTypingTicket|sendTypingStatus|getCurrentRequestId|sendText)\b" tests/` → **无命中**。
- 现存 `channel.getTerminalProcessing()` 命中仅出现在 `tests/bridge/event-wiring.test.ts`、
  `tests/bridge/turn-state.test.ts`，其 `channel` 由 `tests/setup/bridge-harness.ts` 的
  `createBridgeChannel()` 构造（`event-wiring.test.ts:33` `const channel = createBridgeChannel()`），
  是 fake BridgeChannel 上的 mock，**非真 Channel**。
- 新增 `typing.test.ts` 覆盖被删转发方法（`getTypingTicket`/`sendTypingStatus`）经 `TypingController`
  的等价语义；`getCurrentRequestId` 由集成测试直接观察 `queue`。无遗留引用。**PASS**

## check 11 — bridge-harness fake 未被删除

`git diff dev...HEAD -- tests/setup/bridge-harness.ts` 为空。`rg` 确认仍在：

```
tests/setup/bridge-harness.ts:23 setTerminalProcessing / :24 getTerminalProcessing
:28 startTyping / :29 stopTyping / :31 isRequestProcessed / :32 markRequestProcessed
```

`handleMessage`/`triggerAi` 属于 fake 的 `Channel` 类型契约面，`bridge-harness.ts` 完整未改动。**PASS**

## check 12 — vendor 零 diff、无新依赖

`git diff dev...HEAD -- package.json bun.lock` 为空；`--name-status` 未含任何 vendor / lock 文件；
`bun install --frozen-lockfile` 成功（未改写 lockfile）。**PASS**

## check 13 — 提交原子、message 规范、未 push

```
$ git log --oneline dev..HEAD
4054286 refactor(channel): 收敛 facade 公共面，移除仅测试用/已死的转发方法

$ git show-ref | grep cs-7
4054286... refs/heads/refactor/cs-7-facade-narrowing

$ git ls-remote origin refs/heads/refactor/cs-7-facade-narrowing
(empty)   # remote 无该分支 → 未 push
```

单一原子提交、Conventional Commits `refactor(channel): ...`；HEAD detached，工作树干净；
origin 上不存在该分支。**PASS**

---

## 汇总

| # | check | 结果 |
|---|---|---|
| 1 | install/typecheck/test 全绿 0 fail | PASS |
| 2 | diff 未越界 | PASS |
| 3 | acceptance 与行为契约 | PASS |
| 4 | channel.ts 内 5 方法无命中 | PASS |
| 5 | 5 方法无生产调用 | PASS |
| 6 | typing.test.ts 覆盖原 D16 三条 | PASS |
| 7 | D16 删除 / D16b 保留 / 其余未削弱 | PASS |
| 8 | requestId 观察语义等价 | PASS |
| 9 | tests diff 审计 + 断言强度抽查 | PASS |
| 10 | src↔tests 交叉核对无遗留 | PASS |
| 11 | bridge fake 未误删 | PASS |
| 12 | vendor / lock 零 diff | PASS |
| 13 | 提交原子 / 规范 / 未 push | PASS |

**总判定：PASS**（无 FAIL、无未决项）
