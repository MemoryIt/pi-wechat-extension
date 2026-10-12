# Task: CS-3 移除微信入站 slash 命令拦截

base: dev
branch: refactor/cs-3-remove-slash-command
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 189 pass / 21 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误。
  数量：允许 pass/files 计数变化（含下降）；「≥ 基线」不作为通过条件。
  覆盖面：被断言的外部行为集合不得缩小（本阶段为「有意的行为变更」，见下）。
  删除/修改用例必须逐条给出去向（迁移 / 被蕴含 / 失效），写入 result 的 test-changes ledger。
  断言强度：不得削弱（禁止 toBe→toBeTruthy、删 expect、放宽精确值）。
  新增：本阶段变更后的新行为必须有用例覆盖。
invariant: 除下方「行为变更」外，其它路径行为不变；公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 背景与决策

微信入站 slash 命令拦截是自研层的一段“半成品”：以 `/` 开头的消息被拦截，
仅 `/help` 回一句静态“可用命令: /help”，其余 `/xxx` 被静默吞掉、不进 AI。

经决策：**该功能近乎无效**（回显的“命令”在微信侧一个都执行不了）、且造成“静默吞消息”，
予以**整体移除**。移除后，以 `/` 开头的微信消息与普通消息一样进入 AI 路径。
（pi 的真实命令仍不会被微信触发——`sendUserMessage` 绕过 slash 路由，属 pi by design，见 README。）

> 本阶段只移除**自研层**的拦截。若第三方 vendor 层也存在拦截，端到端行为可能不变；
> 那属于冻结的 vendor 部分，**不在本阶段范围**（作为非阻塞观察，不作为通过条件）。

## goal

让自研代码不再承载“入站 slash 命令拦截/回显”职责：

- `Channel.handleMessage` 删除 slash 分支与 `handleSlashCommand`，不再调用 `parseInbound`。
- `inbound-parser` 契约收敛为 `{ text, hasText, hasMedia }`（删除 `isCommand`）。
- 更新 README 中关于“slash 被拦截”的过时描述。

## scope

prod（修改）：
- `src/channel/channel.ts`
  - `handleMessage`：删除 `const parsed = parseInbound(msg);` 与
    `if (parsed.isCommand) { await this.handleSlashCommand(parsed.text, opts); return; }`。
    保留：生成 requestId → 更新 contextToken（`typing.invalidateTicket()` + 条件持久化）→ `triggerAi`。
  - 删除私有方法 `handleSlashCommand`。
  - 删除 `import { parseInbound } from "./inbound-parser.js";`（channel 不再使用）。
- `src/channel/inbound-parser.ts`
  - `ParsedInbound` 删除 `isCommand` 字段；`parseInbound` 删除 `isCommand` 变量与判定；
    返回 `{ text, hasText, hasMedia }`。文件头注释去掉 slash/命令相关描述。

tests（新增/修改）：
- `tests/channel/inbound-parser.test.ts`：删除所有 `isCommand` 断言与用例；对象相等断言改为三字段。
- `tests/channel/channel.test.ts`：更新/删除对已移除内容的注释（如 `// D15：isSlashCommand ...`）；
  **新增一条行为变更回归用例**（见 test-plan）。

docs（修改）：
- `README.md`
  - 「已知限制与排障」中删除“微信侧以 `/` 开头的消息会被引擎拦截；目前仅 `/help` 有响应，其它 `/xxx` 不会进入 AI”，
    改为说明：以 `/` 开头的消息现作为普通消息交给 LLM；但仍不会触发 pi 的真实命令（by design）。
  - 「常见现象」表删除/调整“微信命令无反应”行。

## 行为契约与变更声明

- **行为变更（有意）**：自研 channel 不再拦截以 `/` 开头的微信消息；这类消息与普通消息一样
  走 `contextToken 更新 → triggerAi → AI`。因此 `/foo` 会触发 `host.sendUserMessage`。
- **不变**：
  - pi 的真实命令仍不会被微信触发（`sendUserMessage` 绕过路由，by design）。
  - 非 slash 文本、纯媒体、contextToken 更新/持久化、typing 失效、队列/防重等路径不变。
- **范围声明**：仅移除自研层拦截；vendor 是否拦截不在本阶段范围。

## test-plan

- `tests/channel/inbound-parser.test.ts`：三字段覆盖
  （空 / `item_list` 缺失、单/多 TEXT 以 `"\n"` 拼接、空串保留、空白文本 `hasText=false`、
  纯媒体 `hasMedia=true`、文本+媒体混合、未定义 type 按非 TEXT）。
  删除 isCommand 用例（按 test-policy 在 ledger 记账去向）。
- `tests/channel/channel.test.ts`（新增，行为变更回归）：
  - 经 `Channel.handleMessage` 送入一条文本为 `"/foo"` 的消息 →
    断言 `host.sendUserMessage` 被调用（不再被拦截），且该路径 **不调用** `outbound.sendText`
    （区别于媒体 ack）；并断言此消息 **未** 触发 slash 早退。
  - 既有 contextToken / 队列 / 媒体 / F6 用例保持通过。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] `src/channel/channel.ts`：无 `parseInbound` / `handleSlashCommand` / `isCommand`（`rg` 无命中）
- [ ] `src/channel/inbound-parser.ts`：`ParsedInbound` 仅含 `{ text, hasText, hasMedia }`（`rg "isCommand" src` 无命中）
- [ ] `README.md` 不再声称“以 `/` 开头的消息被拦截/仅 `/help` 有响应”；改为符合新行为
- [ ] 新增行为变更回归用例：`"/foo"` → `host.sendUserMessage` 被调用、`outbound.sendText` 未被调用
- [ ] 其它路径行为与契约不变；`Channel` 公共 API（除内部私有方法）与端口签名不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{channel,inbound-parser}.ts`、`tests/channel/**`、`README.md`
- [ ] result 的 test-changes ledger 完整，无削弱断言；含「行为变更」说明
- [ ] 提交原子、message 规范（`refactor(channel): ...` 或 `feat/chore`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、其它 `src/channel/*.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言；不得以「简化」为由删除无去向的测试
- **本阶段不要删除 `Channel.sendText`**（移除 slash 后它在 `src/` 变为无调用，但清理公开面留待 cs-7）；请在 result 中记录该事实

## report

完成后写 `/tmp/pi-tasks/cs-3.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / 行为变更 / notes），并执行：

`tmux wait-for -S task-cs-3`
