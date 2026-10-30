# CS-3 Verify Result — 移除微信入站 slash 命令拦截

- **verdict: PASS**
- worktree: `/tmp/wt-cs-3-verify`（detached at `9b933a3`）
- base-branch: `refactor/cs-3-remove-slash-command`
- dev: `09b770e`（`git merge-base --is-ancestor dev HEAD` → YES）
- HEAD: `9b933a3e0d48abf7ea1f2fdea2a61c31b7943c31` `refactor(channel): 移除自研层微信入站 slash 命令拦截`
- verifier: read-only（未改代码 / 未提交 / 未 push / 未切分支；仅 `bun install` + 测试 + 写本报告）

---

## 0. 测试与类型检查（check #1）

命令：`bun install --frozen-lockfile && bun run typecheck && bun run test`

```
bun install v1.4.2 … 130 packages installed [122.00ms]
$ tsc --noEmit          （无输出，rc=0，零错误）

 184 pass
 0 fail
 528 expect() calls
Ran 184 tests across 21 files. [969.00ms]
```

- **PASS**。全绿、0 fail、typecheck 零错误。
- baseline 189 pass / 21 files / 0 fail → 现 184 pass（−5）。符合 test-policy「允许低于基线」；净变化 = −6 删除 +1 新增 = −5，与 ledger 自洽。
- `bun install --frozen-lockfile` 成功，无 lockfile 漂移。

---

## 1. 越界检查（check #2 / scope）

`git diff dev...HEAD --stat`：

```
 README.md                            |  5 ++--
 src/channel/channel.ts               | 24 +----------------
 src/channel/inbound-parser.ts        | 10 +++----
 tests/channel/channel.test.ts        | 27 ++++++++++++++++---
 tests/channel/inbound-parser.test.ts | 52 +++++-------------------------------
 5 files changed, 37 insertions(+), 81 deletions(-)
```

`--name-status`：M README.md, M src/channel/channel.ts, M src/channel/inbound-parser.ts, M tests/channel/channel.test.ts, M tests/channel/inbound-parser.test.ts。

- **PASS**：完全落在允许集合 `src/channel/{channel,inbound-parser}.ts`、`tests/channel/**`、`README.md` 内。
- vendor 零 diff：`git diff dev...HEAD -- api auth cdn media messaging types util` 输出为空。
- `package.json` / `bun.lock` 零 diff（`git diff dev...HEAD --stat -- bun.lock package.json` 为空）；无新依赖。
- 其它 `src/channel/*.ts`、`src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts` 全部零 diff。

---

## 2. cs-3.md acceptance / 行为契约逐条核对

| # | 验收点 | 结果 | 证据 |
|---|--------|------|------|
| a | 全绿 / 0 fail / typecheck 零错误 | PASS | 见 §0 |
| b | `src/channel/channel.ts` 无 `parseInbound`/`handleSlashCommand`/`isCommand` | PASS | `rg -n "isCommand" src/channel/channel.ts` → rc=1；`rg -n "parseInbound" src/channel/channel.ts` → rc=1；`rg -n "handleSlashCommand" src` → rc=1 |
| c | `ParsedInbound` 仅 `{text,hasText,hasMedia}`；`rg "isCommand" src` 无命中 | PASS | 接口字段见 §3；`rg -n "isCommand" src` → rc=1 |
| d | README 不再声称“以 / 开头被拦截、仅 /help 有响应” | PASS | 见 §5 |
| e | 新增 `"/foo"` 回归用例：`sendUserMessage` 被调用、`sendText` 未调用 | PASS | 见 §6 |
| f | 其它路径与契约不变；公共 API / 端口签名不变 | PASS | 见 §7；diff 未触及 ports/adapters/其它 channel 文件 |
| g | `git diff dev...HEAD --stat` 未越界 | PASS | 见 §1 |
| h | ledger 完整、无削弱断言、含行为变更说明 | PASS | 见 §8、§9 |
| i | 提交原子、message 规范 | PASS | 单 commit（`dev..HEAD` 仅 1 个），message `refactor(channel): …`；见 §10 |

**行为契约核对**：
- 有意变更已实现：`channel.ts` 中 slash 分支与 `handleSlashCommand` 已整体删除，`/foo` 不再早退，走 `contextToken 更新 → triggerAi → AI`。
- 不变项：`handleMessage` 顺序 = `generateRequestId()` → contextToken 更新（`typing.invalidateTicket()` + 条件 `storage.saveContextToken`）→ `triggerAi`；`MessageRouter` 契约不变（仍用 `parseInbound` 的 `text/hasText/hasMedia`）；pi by-design 的「`sendUserMessage` 绕过 slash 路由」说明保留。

---

## 3. src 契约核对（check #3、#4）

`src/channel/inbound-parser.ts`（当前）：

```ts
export interface ParsedInbound {
  text: string;      // 所有 TEXT 项以 "\n" 拼接（原始文本，不 trim、不过滤空串）
  hasText: boolean;  // 存在 TEXT 项且 text.trim() 为真
  hasMedia: boolean; // 存在 type !== TEXT 的 item
}
…
return { text: parts.join("\n"), hasText, hasMedia };
```

- **PASS**：仅三字段；`isCommand` 变量/字段/判定全部移除；文件头注释已去掉 slash/命令相关描述。
- `rg -n "slash|isCommand|handleSlash" src` → 无命中（rc=1）。

`src/channel/channel.ts#handleMessage`（当前）：

```ts
const requestId = this.generateRequestId();
// 更新 contextToken（如果消息中有）
if (msg.context_token && msg.context_token !== this.state.contextToken) { … typing.invalidateTicket(); … storage.saveContextToken(…) }
// 触发 AI 处理
await this.triggerAi(msg, requestId, opts);
```

- **PASS**：无 `parseInbound`、无 slash 分支、无 `handleSlashCommand`；顺序符合「requestId → contextToken 更新/持久化 → triggerAi」。
- `Channel.sendText` 保留（`src/channel/channel.ts:257`），符合 forbidden「本阶段不要删除 `Channel.sendText`」。
- `parseInbound` 仍被 `src/channel/router.ts:89` 使用（预期内，router 不在本阶段范围）。

---

## 4. README 一致性（check #5）

diff（`README.md`）：

```
-> 另外，微信侧以 `/` 开头的消息会被引擎拦截；目前仅 `/help` 有响应，其它 `/xxx` 不会进入 AI。
+> 另外，自研通道层不再拦截以 `/` 开头的微信消息：这类消息会作为普通用户消息交给 LLM。
+> 但由于上面的路由绕过，它们仍然不会触发 pi 的真实命令（by design）。
…
-| 微信命令无反应 | 见上文「命令不会被路由」 |
+| 微信 `/命令` 不执行 pi 命令 | 见上文「微信发送的 `/命令` 不会触发 pi 命令」；消息会照常交给 LLM |
```

- **PASS**：过时描述已删除；新描述与行为一致（`/` 开头消息交 LLM，但不触发 pi 真实命令）。
- **PASS（by-design 说明保留）**：README 第 152–158 行「微信发送的 `/命令` 不会触发 pi 命令 / `sendUserMessage` 绕过 slash command 路由器」整段未被删改，未被误删。

---

## 5. 行为变更回归用例（check #6）

`tests/channel/channel.test.ts:300`：

```ts
test("CS-3 行为变更：'/' 开头的消息不再被拦截，作为普通消息交给 AI", async () => {
  await channel.initSession();
  await channel.handleMessage(textMessage("/foo"), opts);
  expect(pi.calls.appendEntry[0][0]).toBe("wechat_meta");
  expect(pi.calls.sendUserMessage.length).toBe(1);
  expect(pi.calls.sendUserMessage[0][0]).toBe("/foo");
  expect(pi.calls.sendUserMessage[0][1]).toEqual({ deliverAs: "followUp" });
  expect(outboundMock.sendText).not.toHaveBeenCalled();
});
```

- **PASS**：存在且通过（`bun test` 全绿）。
- 断言强度充分：`toBe`/`toEqual` 精确值 + `sendText` 未被调用，同时覆盖「未早退」与「不发文本回执」。
- **反事实（回归有效性）证据**：`git show dev:src/channel/channel.ts` 显示旧逻辑
  `const parsed = parseInbound(msg); if (parsed.isCommand) { await this.handleSlashCommand(parsed.text, opts); return; }`，
  且 dev 的 `handleSlashCommand` 仅当 `trimmed === "/help"` 才 `sendText`。因此旧代码处理 `/foo` 时既不会调用 `sendUserMessage`，也不会 `appendEntry("wechat_meta")`，该用例在 dev 上必然失败 → 是有效的回归用例。
- `handleMessage` 的调用路径不经任何 mock 直通 `Channel` 实例，`outboundMock.sendText` 未被调用证明新路径不产生媒体 ack / 旧 `/help` 回显。

---

## 6. 其它路径未变（check #7）

- 全量：`184 pass / 0 fail / 21 files`（§0）。
- 定向：`bun test --isolate tests/channel/channel.test.ts tests/channel/queue.test.ts tests/bridge/turn-state.test.ts` → `38 pass / 0 fail / 116 expect() calls`（含 D1 去重释放队列、F6 媒体 ack 抛错仍交文本）。
- `tests/channel/channel.test.ts` 的 contextToken / typing（D16/D16b）/ 队列（B6）/ 媒体（B5）/ F6 用例在 diff 中**零改动**，全部通过（diff 仅涉及文件头注释、D15 注释块、新增用例）。
- 非 slash 文本路径：`router.execute 文本：appendEntry + sendUserMessage` 通过（router.test.ts）。
- 纯媒体：`router.execute 媒体：立即 ack、入后台队列` 通过。
- **PASS**。

---

## 7. 审计 tests diff + ledger 去向（check #8、#9）

### 7.1 删除用例（6 条，全部判为「失效」）

| # | 删除用例（inbound-parser.test.ts） | 去向 | 判定 |
|---|---|---|---|
| 1 | `'/help' → isCommand=true（原 D15 基线）` | 失效 | 断言对象 `isCommand` 已删除；对外行为由新 `/foo` 用例覆盖 |
| 2 | `普通文本 'hi' → isCommand=false（原 D15 基线）` | 失效 | 同上 |
| 3 | `'  /help  ' 前后空白 → isCommand=true` | 失效 | 同上 |
| 4 | `'/unknown' 未知命令 → isCommand=true` | 失效 | 同上 |
| 5 | `slash 出现在第 2 个 TEXT 项 → isCommand=true（原 D15 目标）` | 失效 | 同上 |
| 6 | `第 2 个 TEXT 项为普通文本 → isCommand=false` | 失效 | 同上 |

**判定依据**：这 6 例断言的是 `parseInbound` 返回的 `isCommand` 字段（内部解析细节）。该字段唯一的对外消费者是 `Channel.handleMessage` 的 slash 早退分支；分支与字段一并移除后，`isCommand` 已无任何对外可观察性。其业务意图（slash 不再被特殊对待）由新增的 channel 层 `/foo` 用例在外部可观察层（`sendUserMessage`/`sendText`）覆盖，故覆盖面净无缩小。删除属「失效（功能已移除）」，与 task/ledger 一致。

### 7.2 修改用例（5 处）

| # | 用例 | 改动 | 去向 |
|---|---|---|---|
| 1 | `item_list 缺失 → 三字段全空` | `toEqual` 由 4 字段 → 3 字段（去 `isCommand:false`） | 被蕴含/字段收敛，精确 `toEqual` 保留 |
| 2 | `item_list 为空数组 → 三字段全空` | 同上 | 同上 |
| 3 | `纯媒体（IMAGE）→ …` | `toEqual` 由 4 → 3 字段 | 同上 |
| 4 | `多个 TEXT → 以 \n 精确拼接` | 删除 `expect(parsed.isCommand).toBe(false)`；保留 `text==="a\nb\nc"`、`hasText===true` | 字段失效；其余断言不变 |
| 5 | `空白文本 → text 保留原文、hasText=false` | 删除 `expect(parsed.isCommand).toBe(false)`；保留 `text==="   "`、`hasText===false` | 同上 |

### 7.3 断言强度抽查（≥2 条，未削弱）

- 抽查 A：`多个 TEXT` 仍为 `expect(parsed.text).toBe("a\nb\nc")` + `expect(parsed.hasText).toBe(true)`（精确值，未用 `toBeTruthy`）。
- 抽查 B：`空白文本` 仍为 `expect(parsed.text).toBe("   ")` + `expect(parsed.hasText).toBe(false)`（精确值）。
- 抽查 C：三个 `toEqual` 对象断言仍为完整精确对象比较（仅去掉已不存在的 `isCommand` 键），未放宽为部分匹配。
- 全部 6 条删除用例无「无去向」删除；未出现 `toBe→toBeTruthy`、无删 `expect` 之外的其他强度削弱。

### 7.4 交叉核对 src↔tests（check #9）

- 被删的 `handleSlashCommand`：`rg "handleSlashCommand" src tests` → src rc=1、tests rc=1（无残留）。
- 被删的 `isCommand`/`isSlashCommand`：`src` 零命中；`tests` 中的命中**均为解释性注释**（`channel.test.ts:296`、`inbound-parser.test.ts:5`），非可执行断言或引用，且明确标注「已移除/失效」。
- 新增行为变更用例已覆盖移除后的新行为（§6 已证明）。
- **PASS**。

---

## 8. vendor 零 diff / 无新依赖 / sendText 保留（check #10）

| 检查 | 结果 |
|---|---|
| vendor（`api/ auth/ cdn/ media/ messaging/ types/ util/`）零 diff | PASS（diff 输出为空） |
| `package.json` / `bun.lock` 零 diff | PASS |
| 新依赖 | 无 |
| `Channel.sendText` 未删除 | PASS（`src/channel/channel.ts:257`） |
| 其它 `src/channel/*.ts` 零 diff | PASS（仅 channel.ts、inbound-parser.ts） |

---

## 9. 提交原子性 / message / 未 push（check #11）

- `git log --oneline dev..HEAD` → 仅 `9b933a3 refactor(channel): 移除自研层微信入站 slash 命令拦截`（单个逻辑一个 commit）。
- message 规范：`refactor(channel): …`，符合 acceptance。
- 未 push：`git branch -r --contains HEAD` 为空；`git for-each-ref --contains HEAD` 仅本地 `refs/heads/refactor/cs-3-remove-slash-command`。
- **PASS**。

---

## 10. 非阻塞观察（不作为通过条件）

1. **vendor 是否亦拦截 `/`**：在 vendor 目录 `api/ auth/ cdn/ media/ messaging/ types/ util/` 中搜索 `isCommand|isSlash|startsWith("/")|/help|拦截` → **零命中**；`messaging/inbound.ts` 仅做消息/contextToken 映射，无 slash 过滤。结论：**未发现 vendor 层 slash 拦截**，CS-3 移除自研层拦截后，端到端行为应确实改变（不再静默吞 `/xxx`）。task book 中「vendor 可能拦截」的假设在本仓库当前 vendor 快照下不成立。
2. **`tests/README.md` 第 83 行仍保留 D15 行**：`| D15 | isSlashCommand 魔法数字 + 只看首条 | tests/channel/channel.test.ts | 用 MessageItemType.TEXT 并遍历 |`。该文件未在本阶段 diff 中（符合「diff 仅限 README.md + tests/channel/**」的 scope 约束），属遗留历史文档行，**不影响**本阶段验收；如需清理可留待后续文档阶段。
3. `tests/channel/channel.test.ts:296` / `inbound-parser.test.ts:5` 保留 `isCommand`/`isSlashCommand` 字样，但均为「已移除」说明性注释，非活引用。

---

## 11. 结论

所有 check 项均 **PASS**。CS-3 正确移除了自研 channel 层的入站 slash 拦截/回显职责：
- prod 契约收敛为 `{text,hasText,hasMedia}`，`Channel.handleMessage` 不再解析/早退；
- README 同步、pi by-design 说明保留；
- 新增 `/foo` 行为回归用例有效覆盖新行为；
- 删除的 6 条 isCommand 用例去向明确（失效），断言无削弱；
- 无越界、无 vendor/依赖改动、`Channel.sendText` 保留、未 push。

**verdict: PASS**
