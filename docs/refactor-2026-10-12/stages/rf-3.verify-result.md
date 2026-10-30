# RF-3 独立复验报告

- verdict: **PASS**
- verified-commit: `31822a2`（分支 `refactor/rf-3-instance-state`，detached）
- base: `dev`（HEAD 的祖先为 `3fd67c3`）
- mode: 只读复验。未修改代码 / 未提交 / 未 push；仅执行 `bun install`、测试与只读命令，仅写本报告。
- date: 2026-10-12

## 结论摘要

RF-3 的「去模块级可变状态 + 组合根实例注入」实现完整、语义未回退、测试全绿、diff 未越界。
`rf-3.result.md` 的声明与实测逐项一致。

---

## 逐条核对

### 1. `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿 ✅

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
+ @earendil-works/pi-coding-agent@0.84.4 ... zod@4.3.6
130 packages installed [549.00ms]

$ bun run typecheck        # tsc --noEmit
TYPECHECK_EXIT=0（零错误）

$ bun run test             # bun test --isolate
 158 pass
 0 fail
 454 expect() calls
Ran 158 tests across 18 files. [824.00ms]
```

### 2. 测试数 ≥ 基线，且与 `rf-3.result.md` 一致 ✅

- 基线：155 pass / 17 files / 0 fail。
- 实测：**158 pass / 18 files / 0 fail / 454 expect calls**。
- 增量 = 新增 `tests/bridge/state-isolation.test.ts`（3 例）＋新增文件（+1 file）。`git diff --diff-filter=D --name-only` 为空，无删除测试。
- 与 `rf-3.result.md` 声明的「158 pass / 18 files / 0 fail / 454 expect calls」完全一致。

### 3. `git diff dev...HEAD --stat` 未越界 ✅

```
 src/bridge/events.ts                 |  40 ++++----
 src/bridge/meta.ts                   | 179 ++++++++++++++++++-----------------
 src/bridge/tool-send-file.ts         |   9 +-
 src/bridge/turn.ts                   |  59 ++++++------
 src/index.ts                         |  16 +++-
 tests/bridge/meta.test.ts            |  14 +--
 tests/bridge/state-isolation.test.ts |  69 ++++++++++++++
 tests/bridge/turn.test.ts            |  19 ++--
 8 files changed, 247 insertions(+), 158 deletions(-)
```

命中白名单：`src/bridge/{turn,meta,events,tool-send-file}.ts`、`src/index.ts`、`tests/bridge/*`，无越界文件。

### 4. 模块级可变状态清零 ✅

```
$ rg "^let |^const .* = new (Map|Set)|^const .*: .*\[\] =" src/bridge src/application
exit=1（无命中）
```

补充更宽的扫描（含 `export let/var`、`new Map/Set/WeakMap/WeakSet`、`= []`、`= {}`）同样 `exit=1` 无命中。

`pendingWechatInputs`（`TurnResolver` 私有字段）与 `costAccumulator`/`cachedGitBranch`（`MetaBuilder` 私有字段）均已收为实例字段。

### 5. 模块级 logger 清零 ✅

```
$ rg "^const logger = createLogger" src/
exit=1（无命中）

$ rg "^(export )?const logger" src/
exit=1（无命中）
```

现存 `createLogger` 调用点仅：`src/index.ts:54`（在 `(pi) => {}` 闭包内、缩进创建）与 `src/channel/channel.ts:73`（构造函数内 fallback）。`bridge/events.ts`、`bridge/tool-send-file.ts` 已改为构造注入。

### 6. `TurnResolver` / `MetaBuilder` 为实例类；纯函数导出语义未变 ✅

`src/bridge/turn.ts` `export`：
- `class TurnResolver`（`pushPendingWechatInput` / `resetPendingWechatInputs` / `resolveTurnBeforeRun` 为实例方法）
- 纯函数仍在且签名未变：`getBranch`、`isAssistantMessage`、`resolvePendingWechatMeta`、`resolveTurnFromBranch`、`resolveActiveWechatMeta`、`extractLastReply`、`extractReplyText`。

`src/bridge/meta.ts` `export`：
- `class MetaBuilder`（`refreshGitBranch` / `getCachedGitBranch` / `buildMetaInfo` / `accumulateCost` 为实例方法）
- `readGitBranch(pi)` 仍为模块级函数。

方法体逐行 diff 比对：FIFO 消费（`findIndex` + `splice` 命中即出队、只消费首个匹配）与成本累计（按 entry id 去重、连续增长增量、压缩/分叉回退全量去重、`anchor=lastIndex-1` 且 id 一致才沿用 `start`）逻辑等价搬移，无改写。

### 7. 实例隔离测试存在且通过 ✅

`tests/bridge/state-isolation.test.ts`（新增，3 例，全绿）：
- 两个 `TurnResolver`：向 A push，B 的 `resolveTurnBeforeRun` 返回 `fromWechat:false`；A 命中返回 `R-a` 且出队后再次解析不再命中。
- 两个 `MetaBuilder`：A 累计 0.5，B 空分支为 0（互不共享）。
- 两个 `MetaBuilder` git 缓存：A `refreshGitBranch` 后为 `feature-branch`，B 仍 `null`。

### 8. 既有 D4/D21 与 `event-wiring.test.ts` 全绿且断言未削弱 ✅

```
$ git diff dev...HEAD -- tests/bridge/turn-state.test.ts tests/bridge/event-wiring.test.ts
（空 diff）
```

两个测试文件零改动，且包含在 158 pass 中（0 fail）。断言未被削弱。

### 9. 越界路径 diff 为空 ✅

```
$ git diff dev...HEAD -- src/shared/config.ts src/storage/state.ts src/channel src/ports src/adapters src/application
（空 diff）
```

`shared/config.ts` 的 `cachedConfig` 与 `storage/state.ts` 的 `mutationQueues` 按 out-of-scope 保留，未触碰。

### 10. vendor diff 为空、无新依赖 ✅

```
$ git diff dev...HEAD --stat -- api auth cdn media messaging util types '*.d.ts'   # 空
$ git diff dev...HEAD -- package.json bun.lock                                      # 空
```

`package.json` dependencies 仍为 `@sinclair/typebox` / `qrcode-terminal` / `zod`，无新增。

### 11. 提交原子、message 规范；未 push ✅

```
dev..HEAD:
31822a2 test(bridge): 新增实例状态隔离用例
8376633 refactor(bridge): 去模块级可变状态并改为组合根实例注入
```

- 两提交各司一逻辑（实现 → 测试），message 符合 Conventional Commits（`refactor(bridge):` / `test(bridge):`），正文说明清晰。
- `git branch -r --contains 31822a2` 为空 → 未 push；本地分支无 upstream。

### 12. 行为契约核对（逐条）✅

- `input`：`source === "extension"` 且 `deps.turn.resolveTurnBeforeRun(ctx).fromWechat` 时 `deps.turn.pushPendingWechatInput({requestId, text})`；非 extension 直接 `continue`。
- `before_agent_start`：`deps.turn.resolveTurnBeforeRun(ctx, event.prompt)`；微信 turn 仅 `logger.debug`；非微信 turn `channel.setTerminalProcessing(true)` + debug，文案逐字未变。
- `agent_settled`：`resolveTurnFromBranch(ctx)`；非微信走 `fromWechat:false` DTO（`replyText/metaText = null`，不扫描分支）；微信且有 `replyText` 时 `meta.buildMetaInfo(ctx)`，DTO 字段未变。
- `session_start`：`await meta.refreshGitBranch(pi)`，其余（notifier / `startFromStoredToken`）不变。
- FIFO 消费语义、`costAccumulator` 增量语义：如第 6 条所述等价搬移。
- 依赖方向：`src/bridge/**` 新增 import 仅 `../shared/logger.js`（类型 `PluginLogger`）与 `./turn.js`；未新增 vendor / `channel` 内部实现依赖；`application` 未回退依赖 bridge。

---

## 差异/风险

- 未发现与 `rf-3.result.md` 声明不符之处。
- 未发现未决项或需 human 决策项。
- 复验过程未产生工作区改动：`git status --porcelain` 为空。

## 复验执行的可复现命令

```
cd /workspace/wt-rf-3-verify
bun install --frozen-lockfile
bun run typecheck
bun run test
git diff dev...HEAD --stat
git diff dev...HEAD --name-only
rg "^let |^const .* = new (Map|Set)|^const .*: .*\[\] =" src/bridge src/application
rg "^const logger = createLogger" src/
git branch -r --contains 31822a2
```
