# CS-2 验证报告（只读子 Agent）

- status: **PASS**
- branch/worktree: detached HEAD @ `414c41c`（worktree `/tmp/wt-cs-2-verify`），base `dev` = `490a76a`
- verify-task: `docs/refactor-2026-10-12b/stages/cs-2.verify-task.md`
- 模式合规：未修改代码 / 未提交 / 未 push / 未切换分支；仅执行 `bun install` 与测试。`git status --porcelain` 为空。
- 报告文件：`/tmp/pi-tasks/cs-2.verify-result.md`

---

## 1. 测试命令全绿（PASS）

命令与输出：

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
130 packages installed [255.00ms]

$ bun run typecheck   # tsc --noEmit
TYPECHECK_EXIT=0      # 零错误

$ bun run test        # bun test --isolate
 189 pass
 0 fail
 531 expect() calls
Ran 189 tests across 21 files. [1027.00ms]
TEST_EXIT=0
```

- 计数：**189 pass / 21 files / 0 fail / 531 expect calls**；typecheck 零错误。
- 基线（`cs-2.md`）：176 pass / 20 files / 0 fail。结果高于基线，且按 test-policy「数量不作为通过条件」。
- 结论：PASS。

## 2. scope 未越界（PASS）

```
$ git diff dev...HEAD --name-status
M   src/channel/channel.ts
A   src/channel/inbound-parser.ts
M   src/channel/router.ts
M   tests/channel/channel.test.ts
A   tests/channel/inbound-parser.test.ts

$ git diff dev...HEAD --stat
 5 files changed, 184 insertions(+), 63 deletions(-)

$ git diff dev...HEAD --stat -- vendor api auth cdn media messaging util types package.json bun.lock
(空)
```

- 仅命中允许集合 `src/channel/{inbound-parser,channel,router}.ts` + `tests/channel/**`。
- 用 `grep -vE` 反查非允许路径：`ALL IN SCOPE`。
- 结论：PASS。

## 3. cs-2.md acceptance 与「行为契约」逐条核对（PASS）

见下方逐条；全部满足。详细的语义等价对照见第 7 条。

## 4. `inbound-parser.ts` 存在、导出 `parseInbound`、纯函数、仅依赖 ports/types（PASS）

- 文件存在：`src/channel/inbound-parser.ts`（新增 47 行）。
- 导出：`export function parseInbound(msg: WeixinMessage): ParsedInbound`，并 `export interface ParsedInbound`。
- 依赖：仅 `import type { WeixinMessage } from "../ports/types.js";` 与 `import { MessageItemType } from "../ports/types.js";`（无其他 import）。
- 纯函数/无副作用：函数体内仅局部变量 `parts/isCommand/hasText/hasMedia`，无 I/O、无全局/外部状态读写，返回新对象。
- 结论：PASS。

## 5. `channel.ts` 删除私有方法并改用 `parseInbound`（PASS）

```
$ rg -n "extractText|isSlashCommand" src/channel/channel.ts
rc=1   # 无命中

$ rg -n "parseInbound" src/channel/
src/channel/channel.ts:35:import { parseInbound } from "./inbound-parser.js";
src/channel/channel.ts:199:    const parsed = parseInbound(msg);
```

- `private extractText` / `private isSlashCommand` 已删除（diff 中为纯删除）。
- `handleMessage`：`const parsed = parseInbound(msg);` → `if (parsed.isCommand) { await this.handleSlashCommand(parsed.text, opts); return; }`。
- `handleSlashCommand` 由 `(msg, opts)` 改为 `(rawText, opts)`，内部 `const trimmed = rawText.trim()`；原有 `/help` 文案 `可用命令: /help` 不变；`opts` 仍未使用（签名保留）。
- 结论文案：PASS。

## 6. `router.ts` `execute()` 去除内联判定与文本拼接（PASS）

```
$ rg -n "item_list\?\.some|text_item\?\.text" src/channel/router.ts
rc=1   # 无命中
```

diff 摘要：
- 删除 `hasText = msg.item_list?.some(item => item.type === TEXT && item.text_item?.text?.trim())` 与 `hasMedia = msg.item_list?.some(item => item.type !== TEXT)`，改为 `const parsed = parseInbound(msg)` + `parsed.hasMedia && !parsed.hasText`。
- 删除内联 `textParts` 拼接循环，改为 `const content = parsed.text`。
- 纯媒体分支结构（ack → 后台入队 → mark → 排空）与 F6 ack 失败隔离未改动（diff 仅触及判定与拼接两处）。
- 结论：PASS。

## 7. 解析语义逐字等价（PASS）

逐项对照旧实现（`dev`）与新 `parseInbound`：

| 契约 | 旧实现 | 新实现 | 判定 |
|---|---|---|---|
| `text` | 遍历 `item_list ?? []`，TEXT 项 push `text_item?.text ?? ""`，`parts.join("\n")`；不 trim、不过滤空串 | 同一逻辑 | 等价 |
| `isCommand` | 遍历全部 item，`text=(text_item?.text ?? "")`，`text.trim().startsWith("/")` 即 true（不只看首条） | `if (!isCommand && text.trim().startsWith("/")) isCommand = true` | 等价 |
| `hasText` | `some(TEXT && text_item?.text?.trim())`（truthy） | `if (!hasText && text.trim()) hasText = true` | 等价 |
| `hasMedia` | `some(item.type !== TEXT)` | 非 TEXT 分支 `hasMedia = true` | 等价 |
| 空消息 / 缺 `item_list` | `?.` 短路 → 全空 | `for (const item of msg.item_list ?? [])` 空循环 → `{text:"",isCommand:false,hasText:false,hasMedia:false}` | 等价 |

- 结论：PASS。

## 8. slash 早退顺序不变（PASS）

`src/channel/channel.ts#handleMessage` 源码顺序：`generateRequestId()` → `parseInbound` → `if (parsed.isCommand) { handleSlashCommand; return; }` → contextToken 更新 → `triggerAi`。slash 仍先于 contextToken 更新与 AI 派发。且解析只发生一次（结果下传 `handleSlashCommand`），无重复解析。
- 结论：PASS。

## 9. `Channel` 公共方法与四个窄接口契约不变（PASS）

- `channel.ts` diff 中方法级增删仅：删除 `private extractText`、`private isSlashCommand`，`private handleSlashCommand` 形参改名；无任何 public/protected 签名变化（`git diff ... | rg "^[+-].*(async|public|private|protected)"` 已核对）。
- 四个窄接口未经改动（均不在 5 文件 diff 内）：
  - `BridgeChannel`：`src/bridge/events.ts:34`
  - `SendFileChannel`：`src/bridge/tool-send-file.ts:16`
  - `ReplyChannel`：`src/application/types.ts:24`
  - `SessionChannel`：`src/application/session.ts:36`
- `src/ports/**` diff 为空，端口签名不变。
- 结论：PASS。

## 10. tests/ diff 审计（PASS）

`tests/channel/channel.test.ts` 的改动仅为**删除 2 个用例 + 增加去向注释**，无修改/削弱：

| # | 删除用例 | ledger 去向 | 审计判定 |
|---|---|---|---|
| 1 | `D15 基线：首条即为文本且以 / 开头时判定为 slash command`（2 断言：`/help`→true、`hi`→false） | 迁移 → `inbound-parser.test.ts` 用例「'/help' → isCommand=true」「普通文本 'hi' → isCommand=false」 | 逐字迁移，`toBe(true/false)` 原样保留 |
| 2 | `D15 目标：应能识别非首条文本中的 slash command`（1 断言 `isSlash(msg)`→true） | 迁移 → `inbound-parser.test.ts`「slash 出现在第 2 个 TEXT 项 → isCommand=true」 | 逐字迁移，`toBe(true)` 保留 |

- 抽查 ≥2 条确认断言强度未削弱：
  - 抽查 A：原 `expect(isSlash({item_list:[{type:TEXT,text_item:{text:"/help"}}]})).toBe(true)` ↔ 新 `expect(parseInbound({item_list:[textItem("/help")]}).isCommand).toBe(true)` → 精确 `toBe(true)`，无 `toBeTruthy` 化。
  - 抽查 B：原非首条 slash `expect(isSlash(msg)).toBe(true)` ↔ 新 `expect(parseInbound(msg).isCommand).toBe(true)` → 精确 `toBe(true)`。
- 其余 `channel.test.ts` 用例（slash 之外：contextToken / 队列 / 媒体 / F6 / D6 / D13 / D14 / D16 等）零改动；`MessageItemType` 仍被 line 582 使用，import 未误删。
- 新增 `inbound-parser.test.ts` 15 用例，采用 `toEqual` 精确对象与 `toBe` 精确值，覆盖 test-plan 全部条目（空/缺失 item_list、单/多 TEXT 拼接、空串保留、空白文本、slash 各形态、第 2 项 slash、纯媒体、混合、未定义 type）。
- 结论：PASS。

## 11. src↔tests 交叉核对（PASS）

- 被改动的 prod 符号：仅私有方法 `extractText` / `isSlashCommand` / `handleSlashCommand`，公共 API 未变。
- 原绑定私有 `isSlashCommand` 的行为断言（D15×2）已迁移到新公共模块 `parseInbound` 的测试，覆盖去向明确。
- 新公共行为 `parseInbound` 有独立测试文件，覆盖四字段全部语义与边界。
- `MessageRouter` / `Channel` 既有测试（router.test.ts 文本/媒体/F6；channel.test.ts slash 之外）保持通过。
- 备注（非阻断）：`handleMessage` 的 slash `sendText("可用命令: /help")` 公共路径此前亦无集成用例（dev 上 D15 仅直测私有方法），CS-2 未新增该集成用例，属既有覆盖缺口，未因本阶段引入回归；行为由语义等价 + `parseInbound` 用例 + typecheck 保障。
- 结论：PASS。

## 12. vendor 零 diff、无新依赖（PASS）

- vendor 目录（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）零 diff（name-status 仅 5 文件，且 `git diff ... -- vendor api ...` 为空）。
- `package.json` / `bun.lock` 零 diff；`git diff dev...HEAD --stat -- package.json bun.lock` 为空。
- 结论：PASS。

## 13. 提交原子、message 规范、未 push（PASS）

```
$ git log --oneline dev..HEAD
414c41c refactor(channel): 抽取 inbound-parser 统一入站消息解析

$ git rev-parse HEAD
414c41c0730df875b1fbbae514c1b2b01ae1802f
$ git merge-base --is-ancestor dev HEAD && echo "dev is ancestor"   # ok
$ git branch -a --list '*cs-2*'
+ refactor/cs-2-inbound-parser        # 仅本地，无 origin/ 对应分支
$ git config --get branch.refactor/cs-2-inbound-parser.remote || echo "(no upstream configured)"
(no upstream configured)
```

- 单一原子提交，message 前缀 `refactor(channel):` 规范。
- 无远程对应分支、无 upstream → 未 push。
- `dev` 为 HEAD 祖先且未被改动。
- 结论：PASS。

---

## 最终裁决

**PASS** — 全部 10 项 verify-task 检查通过，`.md` acceptance 与行为契约逐条满足；测试 189 pass / 0 fail / 531 expect、typecheck 零错误；scope、tests 去向、断言强度、vendor/依赖、提交规范均无问题。
