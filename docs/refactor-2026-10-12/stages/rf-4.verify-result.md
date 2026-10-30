# RF-4 独立复验报告

- verdict: **PASS**
- verified-commit: `2f49cedb2652e6a1ffccd56c9d1a7a120c699602`（`fix(channel): startPolling 同步进入 connecting`，分支 `refactor/rf-4-connecting`，worktree detached）
- base: `dev`（已确认是 HEAD 祖先）
- mode: 只读复验。未修改代码 / 未提交 / 未 push；仅执行 `bun install --frozen-lockfile`、typecheck、测试与只读 git 命令；仅写本报告。
- date: 2026-10-12

## 结论摘要

RF-4「startPolling 同步进入 connecting」实现完整：connect 状态同步生效、无凭证回落 disconnected、stop/reset/needs_relogin/重入语义未回退、配置/依赖/vendor 零改动、diff 未越界、提交原子且未 push。`rf-4.result.md` 声明的所有数字与事实与实测逐项一致。

---

## 逐条核对（按 verify-task 清单）

### 1. `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿 ✅

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
+ @earendil-works/pi-coding-agent@0.84.4 ... zod@4.3.6
130 packages installed [443.00ms]

$ bun run typecheck        # tsc --noEmit
exit=0（零错误）

$ bun run test             # bun test --isolate，exit=0
 160 pass
 0 fail
 458 expect() calls
Ran 160 tests across 18 files. [778.00ms]
```

### 2. 测试数 ≥ 基线 158/18/0，与 `rf-4.result.md` 一致 ✅

- 基线：158 pass / 18 files / 0 fail。
- 实测：**160 pass / 18 files / 0 fail / 458 expect calls**。
- 增量核对：`tests/channel/channel.test.ts` 中 HEAD 的 `test(` 调用数为 23，dev 为 21（+2，与报告「新增 2」一致）；`git diff dev...HEAD --diff-filter=D --name-only` 为空 → 无测试被删除，既有断言未被削弱（diff 仅 46 行纯新增，0 删除）。
- 与 `/tmp/pi-tasks/rf-4.result.md` 声明「160 pass / 18 files / 0 fail / 458 expect calls」完全一致。

### 3. `git diff dev...HEAD --stat` 未越界 ✅

```
 src/channel/polling.ts        |  4 ++++
 tests/channel/channel.test.ts | 42 ++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 46 insertions(+)
```

仅命中白名单 2 文件。`git diff dev...HEAD --stat -- package.json bun.lock api auth cdn media messaging util types '*.d.ts' src/application src/bridge src/ports src/adapters` → 空，越界路径零 diff，未新增依赖。

### 4. `rf-4.md` acceptance 逐条 ✅

| acceptance | 结果 |
|---|---|
| 全绿、用例 ≥ 158 | ✅ 160 pass / 18 files / 0 fail（`typecheck_exit=0 test_exit=0`） |
| `polling.ts` start() 在 `ensureSession()` 前同步置 connecting | ✅ 见第 5 节代码证据 |
| 新增 A3 用例通过 | ✅ 见第 6 节（目标用例 + 可选用例均 pass） |
| diff 仅限 2 文件 | ✅ 见第 3 节 |
| 提交原子、message 规范 | ✅ 单 commit `fix(channel):`，Conventional Commits，prod+测试同一逻辑 |

### 5. 行为契约逐条核对 ✅

`src/channel/polling.ts` `start()`（关键行）：

```
if (this.pollingActive) {          // 重入守卫：先于 connecting，重入不改状态
  ... return;
}
this.pollingActive = true;
const generation = ++this.pollingGeneration;
this.state.connectionState = "connecting";   // ← 新增，位于首个 await（ensureSession）之前
if (this.abortController.signal.aborted) { ... }
...
if (!(await this.deps.ensureSession())) { return; }   // 首个 await 在 connecting 之后
```

- [x] **同步开启 connecting**：else 分支先置 `connecting` 才遇到首个 `await`（`ensureSession`），调用 `startPolling` 时同步生效。无任何 await 夹在守卫与赋值的中间。
- [x] **首次 getUpdates 成功 → connected**：循环体成功路径 `this.state.connectionState = "connected"`（原逻辑保留）。
- [x] **无凭证不卡 connecting**：`ensureSession()` 返回 false → early `return` → `finally` 中（generation 未过期时）置 `disconnected`；`needs_relogin` 终态不被 `disconnected` 覆盖（`if (this.state.connectionState !== "needs_relogin")`）。
- [x] **stop() / reset() → disconnected**：`stop()` abort + `disconnected`；`reset()` 令 generation 过期 + `disconnected`。两者未被本次改动触碰（diff 仅 start() 内 +4 行）。
- [x] **needs_relogin 终态不被覆盖**：会话过期（`errcode === -14` 或 `code === -14`）→ `needs_relogin` + `onNeedsRelogin()` 后 return；finally 保留该终态。B4 用例（`isolated.connectionState === "needs_relogin"`）实测通过。
- [x] **重入语义未回退**：`pollingActive === true` 时在置连接状态之前直接 return，不改变当前状态。D3 用例（重复 startPolling 仅 1 次 getUpdates 调用）实测通过。
- [x] **getter 委托与文案不变**：`Channel.connectionState` 仍 `return this.poller.connectionState`（channel.ts L145-146）；`/wechat status` 文案 `Connection: ${this.channel.connectionState}`（session.ts L185）未改。

### 6. 新增 A3 用例确实覆盖「未返回前 === connecting / 返回后 === connected」✅

`tests/channel/channel.test.ts` 新增 2 例（L139-176），实测全绿：

- 「A3 目标」：`inboundMock.getUpdates` 首次调用挂起（手动 resolve promise）；`const p = channel.startPolling(opts)` 后**立即** `expect(channel.connectionState).toBe("connecting")`（此时首次 getUpdates 尚未 resolve）；resolve `{ messages: [], cursor: "" }` → `waitFor(connected)`；`stopPolling()` 并 `await p` → `disconnected`。完整覆盖「窗口期 === connecting → 返回后 === connected → 停止回落 disconnected」。
- 「A3 可选」：`resetAgentDir()` 清空凭证造无凭证场景 → `startPolling` 立即同步 `connecting` → `await p` 结束后 `disconnected`（不卡 connecting）。

### 7. 未引入 `SessionService.phase` / 第二份连接状态 ✅

`grep -rn "SessionService" | grep "\.phase"` 与全库 `\.phase` 扫描无命中；`connectionState` 唯一声明于 `PollingLoop`（`src/channel/polling.ts` L66/L69，初始 `"disconnected"`），`Channel` 仅委托 getter，无第二份状态。`"connecting"` 是 `ConnectionState` 既有成员，本次首度使用。

### 8. 提交原子、message 规范；未 push ✅

```
2f49ced fix(channel): startPolling 同步进入 connecting   (pi-bot)
```

- 单提交，prod（+4）与对应测试（+42）同属一个逻辑，message 为 Conventional Commits 且描述准确；`git status --porcelain` 为空 → 复验未产生工作区改动。
- `git merge-base --is-ancestor dev HEAD` → 是；`git ls-remote origin refactor/rf-4-connecting` 为空、`git branch -r --contains 2f49ced` 为空 → **未 push**；本地仅 `refactor/rf-4-connecting` 指向该提交（`+` 表示在其他 worktree 检出，与本文 detached 状态无关）。

---

## 差异/风险

- 与 `/tmp/pi-tasks/rf-4.result.md` 声明无任何不符（数字、scope、行为契约逐项一致）。
- 唯一 prod 改动位于 start() 中重入守卫之后、首个 await 之前，符合「同步」要求；既有 stop/reset/needs_relogin/finally 逻辑逐行比对未变。
- 未发现未决项或需 human 决策项。

## 复验执行可复现命令

```
cd /workspace/wt-rf-4-verify
bun install --frozen-lockfile
bun run typecheck            # exit 0
bun run test                 # 160 pass / 18 files / 0 fail / 458 expect
git diff dev...HEAD --stat   # 仅 polling.ts(+4) 与 channel.test.ts(+42)
git diff dev...HEAD --name-status
git merge-base --is-ancestor dev HEAD
git ls-remote origin refactor/rf-4-connecting   # 空 → 未 push
grep -rn "SessionService" src tests | grep -i phase   # 无命中
```