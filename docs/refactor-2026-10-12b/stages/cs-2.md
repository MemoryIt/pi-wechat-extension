# Task: CS-2 入站消息解析器抽取（inbound-parser）

base: dev
branch: refactor/cs-2-inbound-parser
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 176 pass / 20 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误。
  数量：允许 pass/files 计数变化（含下降）；「≥ 基线」不作为通过条件。
  覆盖面：被断言的外部行为集合不得缩小。
  删除/修改用例必须逐条给出去向（迁移 / 被蕴含 / 失效），写入 result 的 test-changes ledger。
  断言强度：不得削弱（禁止 toBe→toBeTruthy、删 expect、放宽精确值）。
  新增：本阶段新增的公共行为必须有用例覆盖。
invariant: 正常路径行为不变；Channel / MessageRouter 公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 现象（问题）

微信消息内容解析（“翻译”职责）散落在编排层，且**重复实现**：

1. `src/channel/channel.ts` 私有方法：
   - `extractText(msg)`：遍历 `item_list`，TEXT 项 `text_item?.text ?? ""` 以 `"\n"` 拼接。
   - `isSlashCommand(msg)`：遍历 `item_list`，TEXT 项 `text.trim().startsWith("/")`。
   - `handleMessage` 用 `isSlashCommand`；`handleSlashCommand` 用 `extractText(msg).trim()`。
2. `src/channel/router.ts` 的 `execute()` 内联了同一套判断与拼接：
   - `hasText = item_list?.some(item => item.type === TEXT && item.text_item?.text?.trim())`
   - `hasMedia = item_list?.some(item => item.type !== TEXT)`
   - `content` = 遍历 TEXT 项以 `"\n"` 拼接（与 `extractText` 同构）

同一“微信方言 → 内部文本/标志”的解析逻辑存在两份，且不属于编排职责。

## goal

新增纯解析模块 `src/channel/inbound-parser.ts`，把解析从编排层移出并消除重复：

- 导出 `parseInbound(msg: WeixinMessage): { text: string; isCommand: boolean; hasText: boolean; hasMedia: boolean }`。
- `channel.ts` 删除私有 `extractText` / `isSlashCommand`，改用 `parseInbound`（`handleMessage` / `handleSlashCommand`）。
- `router.ts` 的 `execute()` 改用 `parseInbound` 的 `hasText` / `hasMedia` / `text`，删除内联判断与拼接。

## scope

prod（新增）：
- `src/channel/inbound-parser.ts`

prod（修改）：
- `src/channel/channel.ts`：删除 `private extractText` / `private isSlashCommand`；`handleMessage` 用 `parseInbound(msg).isCommand`；
  `handleSlashCommand` 用 `parseInbound(msg).text.trim()`（或由调用方传入已解析结果以避免重复解析）。
- `src/channel/router.ts`：`execute()` 用 `parseInbound(msg)` 的 `hasText` / `hasMedia` / `text`（`content = parsed.text`）。

tests（新增/修改）：
- 新增 `tests/channel/inbound-parser.test.ts`。
- `tests/channel/channel.test.ts` / `tests/channel/router.test.ts`：仅在 import/构造受影响处同步；**行为断言不得削弱**。

## 目标 API（名称可微调，语义必须一致）

```ts
// src/channel/inbound-parser.ts
import type { WeixinMessage } from "../ports/types.js";

export interface ParsedInbound {
  text: string;       // 所有 TEXT 项以 "\n" 拼接（原始文本，不做 trim）
  isCommand: boolean; // 任一 TEXT 项 text.trim().startsWith("/")
  hasText: boolean;   // 任一 TEXT 项 text_item?.text?.trim() 为真
  hasMedia: boolean;  // 存在非 TEXT 项
}

export function parseInbound(msg: WeixinMessage): ParsedInbound;
```

## 行为契约（必须保持，逐字等价）

- `text`：遍历 `item_list`，仅 TEXT 项取 `text_item?.text ?? ""`，以 `"\n"` 拼接；**不 trim**、不过滤空串。
- `isCommand`：遍历 `item_list`，任一 TEXT 项满足 `(text ?? "").trim().startsWith("/")` 即为 true（遍历全部 item，不只看首条）。
- `hasText`：存在 TEXT 项且 `text_item?.text?.trim()` 为真（空白文本不算）。
- `hasMedia`：存在 `type !== TEXT` 的 item。
- 空消息 / `item_list` 缺失：`text=""`、`isCommand=false`、`hasText=false`、`hasMedia=false`。
- `router.execute` 的分支判定（纯媒体 vs 文本）与注入内容与现状**完全一致**：
  - 纯媒体（hasMedia && !hasText）：ack + 后台入队 + mark + 排空（F6 ack 失败隔离不变）。
  - 文本：`appendEntry("wechat_meta", {requestId})` + `sendUserMessage(content, {deliverAs:"followUp"})`，`content` 现等于原拼接结果。
- `channel.handleMessage` 顺序不变：slash 早退（先于 contextToken 更新与 AI 派发）。

## test-plan

- 新增 `tests/channel/inbound-parser.test.ts`：
  - 空消息 / `item_list` 缺失 → 四字段全空。
  - 单个 TEXT、多个 TEXT → `text` 以 `"\n"` 精确拼接。
  - 空白文本（如 `"   "`）→ `text` 保留原文，`hasText=false`。
  - slash：`"/help"`、`"  /help  "`、`"/unknown"`、普通文本、slash 出现在第 2 个 TEXT 项 → `isCommand` 正确。
  - 纯媒体（IMAGE）→ `hasMedia=true`、`hasText=false`、`text=""`、`isCommand=false`。
  - 文本+媒体混合 → `hasMedia=true`、`hasText=true`。
- 既有 `tests/channel/channel.test.ts`（slash / contextToken / 队列）与 `tests/channel/router.test.ts`（文本/媒体/F6）保持通过；若 import 变化，仅同步 import，不断言削弱。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] 新增 `src/channel/inbound-parser.ts`，导出 `parseInbound`（纯函数，无副作用）
- [ ] `src/channel/channel.ts` 删除 `extractText` / `isSlashCommand`（`rg` 无命中）；改用 `parseInbound`
- [ ] `src/channel/router.ts` 的 `execute()` 不再内联 `hasText`/`hasMedia`/文本拼接，改用 `parseInbound`
- [ ] 解析语义与「行为契约」逐条一致（新用例覆盖）
- [ ] `Channel` / `MessageRouter` 公共 API 与窄接口契约不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{inbound-parser,channel,router}.ts`、`tests/channel/**`
- [ ] result 的 test-changes ledger 完整，无削弱断言
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、`src/channel/polling.ts`、`src/channel/queue.ts`、`src/channel/typing.ts`、`src/channel/sender.ts`、`src/channel/media-store.ts`、`src/channel/state.ts`、`src/channel/request-id.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言；不得以「简化」为由删除无去向的测试

## report

完成后写 `/tmp/pi-tasks/cs-2.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-2`
