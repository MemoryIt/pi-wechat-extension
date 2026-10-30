# Task: CS-DOC 文档同步（channel 瘦身后的架构文档收尾）

base: dev
branch: refactor/cs-doc-sync
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 194 pass / 24 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误（本阶段仅文档，预期测试零改动）。
  数量：允许 pass/files 计数变化；「≥ 基线」不作为通过条件。
  覆盖面：不得修改任何测试断言。
invariant: 仅改文档；`src/`、`tests/**`、vendor、lockfile 零改动；不改变任何代码行为
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 背景

cs-1～cs-7 对 `src/channel/` 做了结构收敛，但当前文档（`docs/ARCHITECTURE.md`、`docs/c4/*.puml`、
`tests/README.md`）仍描述**旧结构**（Channel 私有 `generateRequestId`/slash 方法、Channel 直接持有
queue/requestId/媒体等）。本阶段把当前文档同步为**代码事实**，并补齐本轮重构档案。

**代码事实（cs-1～cs-7 后的 `src/channel/`）**：
- `channel.ts`：`Channel` 构造函数仅委托 `createChannelRuntime(deps)` 装配；公共方法仅剩
  `connectionState / setHost / setNotifier / setConfig / setTerminalProcessing / initSession /
  stopPolling / startPolling / handleMessage / triggerAi / onAiDone / startTyping / stopTyping /
  sendFile / sendReply / isRequestProcessed / markRequestProcessed / reset`。
  `handleMessage` 委托 `InboundHandler`；`triggerAi`/`onAiDone` 委托 `MessageRouter`。
  已删除：`getTerminalProcessing / getTypingTicket / sendTypingStatus / getCurrentRequestId / sendText`
  以及私有 `generateRequestId / getCredentials / getCurrentOpts / isSlashCommand / extractText / handleSlashCommand`。
- 新增：`create-channel.ts`（`createChannelRuntime`/`ChannelRuntime`）、`inbound-handler.ts`
  （`InboundHandler`：requestId 生成 + contextToken 同步 + 派发）、`inbound-parser.ts`
  （`parseInbound`：`{text,hasText,hasMedia}`）、`credential-loader.ts`（`CredentialLoader.ensureSession`）。
- `router.ts`：`MessageRouter` **拥有** `TurnQueue`，提供 `dispatch`/`onTurnDone`/`execute`/`drain`。
- `request-id.ts`：`RequestIdGenerator` 现由 `InboundHandler` 持有（不再由 Channel）。
- 入站 slash 命令拦截与回显**已整体移除**（cs-3）：`/` 开头消息现作为普通消息交给 LLM。
- `src/index.ts` / `ChannelDeps` / 端口签名 / 窄接口（BridgeChannel/SendFileChannel/ReplyChannel/SessionChannel）不变。

## scope（仅文档）

A. `docs/ARCHITECTURE.md`
- §2 依赖/结构示意：`channel/*` 行补入 `inbound-parser / inbound-handler / credential-loader / create-channel`；
  说明 `MessageRouter` 拥有 `TurnQueue`。
- §3.3 channel 表：更新 `channel.ts`（facade，构造委托工厂）、`router.ts`（turn 编排唯一入口 + 拥有队列）；
  新增 `create-channel.ts`、`inbound-handler.ts`、`inbound-parser.ts`、`credential-loader.ts` 四行。
- §4.1：入站路径更新为 `InboundHandler` → `router.dispatch`。
- §4.3（第 144 行）：把「`Channel` 私有 `generateRequestId()`」改为「`InboundHandler` 持有
  `RequestIdGenerator` 并生成 requestId」。
- §7.2 项目结构：`channel/` 文件清单补齐新文件。
- 全文核对：不再出现 `generateRequestId / isSlashCommand / extractText / handleSlashCommand`。

B. `docs/c4/03a-channel.puml`
- 新增组件：`inbound-parser`、`inbound-handler`、`credential-loader`、`create-channel`。
- 修正 `Rel(channelCore, requestId, "generateRequestId 委托")`：requestId 改由 `inbound-handler` 持有。
- 更新 `channelCore` 描述与关系（`inbound-handler → state/typing/router/storage`；
  `messageRouter` 拥有 `TurnQueue`；`create-channel` 装配各组件；`credential-loader → storage/state`）。

C. `docs/c4/04-class-channel.puml`
- `Channel` 类：字段改为实际保有（`state/logger/credentialLoader/poller/typing/sender/router/inboundHandler`），
  删除 `sleep/mediaStore/mediaQueue/queue/requestId`；公共成员按上面「代码事实」更新（删除已删方法）；
  构造函数标注「委托 `createChannelRuntime`」。
- 新增类/节点：`InboundHandler`（`+ handle`，持有 `RequestIdGenerator`）、`CredentialLoader`（`+ ensureSession`）、
  `createChannelRuntime`（工厂）、`parseInbound`（函数）。
- 组合/使用关系更新：`MessageRouter *-- TurnQueue`；`InboundHandler *-- RequestIdGenerator`；
  `InboundHandler ..> storage`；`MessageRouter ..> parseInbound`；删除 `Channel *-- RequestIdGenerator/TurnQueue/MediaStore/SerialTaskQueue`。
- 全图核对：不再出现已删除方法/字段。

D. `tests/README.md`
- D13 行：目标测试改为 `tests/channel/request-id.test.ts`（同毫秒唯一由 `RequestIdGenerator` 覆盖）。
- D15 行：标注「已移除（CS-3：入站 slash 拦截整体删除）」。
- 分层/回归说明同步本轮新增测试文件（`typing / inbound-parser / inbound-handler / credential-loader`）。

E. 新增 `docs/refactor-2026-10-12b/README.md`（本轮档案索引）
- 基本信息（基线 dev、模型）、目标（channel 瘦身）、阶段总览表（cs-1～cs-7 + cs-doc 状态）、
  每阶段一句话结果、最终 `src/channel/` 结构、测试数演进（188→194 等实际值，按归档 result 为准）、
  流程约定（worktree + 实现/验证子 Agent + 归档）。

F. 新增 `docs/refactor-2026-10-12b/e2e-manual-2026-10-12b.md`（人工验收清单）
- 基于上一轮 e2e 清单改编：登录/持久化、双向文本、turn 识别、typing、队列、媒体、文件发送、命令生命周期；
  **明确标注「本轮为架构重构，未人工执行；行为由 194 个自动化用例覆盖」**，并把「`/` 开头消息现进入 AI」
  作为行为变更条目列出。

## forbidden

- 不得修改 `src/**`、`tests/**`（除 `tests/README.md`）、`api/ auth/ cdn/ media/ messaging/ util/`、
  `types/*.d.ts`、`package.json`、`bun.lock`
- **不得修改历史档案**：`docs/refactor-2026-10-11/**`、`docs/refactor-2026-10-12/**`、
  `docs/refactor-2026-10-12b/stages/**`（cs-1..cs-7 四件套为历史记录，保持原样）
- 不得改 `README.md` 的功能/限制章节（cs-3 已更新；如发现与事实不符可修正，但需在 result 说明）
- 不得 push；不得改 `dev`
- 不得引入非文档类改动

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（预期 194 pass，测试零改动）
- [ ] `rg "generateRequestId|isSlashCommand|extractText|handleSlashCommand" docs/ARCHITECTURE.md docs/c4` 无命中
- [ ] `docs/ARCHITECTURE.md` §3.3 含 `create-channel.ts`、`inbound-handler.ts`、`inbound-parser.ts`、`credential-loader.ts`；§4.3 requestId 归属为 `InboundHandler`
- [ ] `docs/c4/04-class-channel.puml` 的 `Channel` 不再列出已删方法/字段；含 `InboundHandler`/`CredentialLoader`/`createChannelRuntime`/`parseInbound`
- [ ] `docs/c4/03a-channel.puml` requestId 关系改由 `inbound-handler` 持有
- [ ] `tests/README.md` D13 → `request-id.test.ts`；D15 标注已移除
- [ ] 新增 `docs/refactor-2026-10-12b/README.md` 与 `e2e-manual-2026-10-12b.md`
- [ ] `git diff dev...HEAD --stat` 仅限 `docs/**`、`tests/README.md`
- [ ] `git diff dev...HEAD -- src tests -- ':!tests/README.md' api auth cdn media messaging util types package.json bun.lock` 为空
- [ ] 提交原子、message 规范（`docs(arch): ...` / `docs(refactor): ...`）

## report

完成后写 `/tmp/pi-tasks/cs-doc.result.md`（schema：status / branch / commits / tests / docs-changes /
scope-check / acceptance / notes），并执行：

`tmux wait-for -S task-cs-doc`
