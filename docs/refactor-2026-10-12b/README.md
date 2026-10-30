# 重构档案：channel 瘦身与协作类收敛（2026-10-12b）

本目录记录 **pi-wechat-extension** 在 2026-10-12 起的第三轮重构：在「轻量 Ports & Adapters」
（`docs/refactor-2026-10-11/`）与「application 用例层 + 状态收敛」（`docs/refactor-2026-10-12/`）
基础上，对 `src/channel/` 做**结构收敛**——把装配、入站处理、消息解析、凭证加载从
`Channel` 编排器中抽出为独立协作类，让 `MessageRouter` 成为 turn 编排唯一入口并拥有队列，
最后收敛 `Channel` facade 的公共面。

> 目录与文件约定：`docs/refactor-<date>/`（README + e2e-manual）+ `stages/` 每阶段四件套。
> 沿用方案 B（点号 + 角色后缀）：
>
> | 角色 | 文件名 |
> |---|---|
> | 任务书 | `<s>.md` |
> | 验证指令（给 verifier） | `<s>.verify-task.md` |
> | 实现结果 | `<s>.result.md` |
> | 验证报告 | `<s>.verify-result.md` |
>
> 运行时交接目录为 `/tmp/pi-tasks/`，完成信号用 `tmux wait-for -S task-<s>` / `task-<s>-verify`。

## 基本信息

| 项 | 值 |
|---|---|
| 起始基线 | `dev` @ `996e347`（v0.5.0） |
| 模型 | `opencode-go/deepseek-flash` |
| 自动测试基线 | **171 pass / 20 files / 0 fail**；`bun run typecheck` 零错误 |
| 验收基线（cs-doc） | **194 pass / 24 files / 0 fail**；`bun install --frozen-lockfile` + `typecheck` + `test` 全绿 |
| 运行时 | Node ≥ 22.19；开发/测试用 Bun |
| vendor | `api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts` **冻结，零改动** |
| 所有权 | 仅重构 `src/channel/`；对外行为除 CS-3 声明的 slash 变更外保持不变 |

## 目标

1. `MessageRouter` 成为 turn 编排唯一入口，并**拥有 `TurnQueue`**（状态迁移集中）。
2. 把入站相关职责从 `Channel` 抽出：`inbound-parser`（纯函数解析）、`inbound-handler`
   （requestId + contextToken 同步 + 派发）。
3. 把会话基础设施抽出：`credential-loader`（凭证加载）。
4. 把「`new` 各协作类并注入回调」的装配逻辑抽到 `create-channel` 工厂，`Channel` 退化为 facade。
5. 收敛 `Channel` facade 公共面，删除仅测试用 / 已死的转发方法。
6. 每阶段保持 `bun run typecheck` 与全套测试全绿。

## 阶段总览

| 阶段 | 内容 | 分支 | 提交 | 测试 | 状态 |
|---|---|---|---|---|---|
| **CS-1** | `MessageRouter` 成为 turn 编排唯一入口并拥有 `TurnQueue` | `refactor/cs-1-turn-orchestration` | `27e87b2` | 176 pass / 20 files | ✅ 完成 |
| **CS-2** | 抽出 `inbound-parser`（`parseInbound` 纯函数） | `refactor/cs-2-inbound-parser` | `414c41c` | 189 pass / 21 files | ✅ 完成 |
| **CS-3** | 移除自研层入站 slash 命令拦截（行为变更） | `refactor/cs-3-remove-slash-command` | `9b933a3` | 184 pass / 21 files | ✅ 完成 |
| **CS-4** | 抽出 `credential-loader`（`CredentialLoader.ensureSession`） | `refactor/cs-4-credential-loader` | `0e34493` | 188 pass / 22 files | ✅ 完成 |
| **CS-5** | 抽出 `inbound-handler`，打破 poller 回调闭环 | `refactor/cs-5-inbound-handler` | `75ff996` | 194 pass / 23 files | ✅ 完成 |
| **CS-6** | 抽出内部装配工厂 `createChannelRuntime` | `refactor/cs-6-channel-factory` | `70ece24` | 194 pass / 23 files | ✅ 完成 |
| **CS-7** | 收敛 `Channel` facade 公共面（删仅测试用 / 已死转发方法） | `refactor/cs-7-facade-narrowing` | `4054286` | 194 pass / 24 files | ✅ 完成 |
| **cs-doc** | 文档同步（ARCHITECTURE / C4 / tests README + 本轮档案） | `refactor/cs-doc-sync` | 本阶段 | 194 pass / 24 files | ✅ 完成 |

## 每阶段一句话结果

- **CS-1**：`router.ts` 新增 `dispatch` / `onTurnDone` 并暴露 `readonly queue`；`Channel` 删除
  `TurnQueue` 字段，`triggerAi` / `onAiDone` 改为委托，队列状态迁移仅由 router 改写。
- **CS-2**：新增 `inbound-parser.ts`；`channel.ts` 删除私有 `extractText` / `isSlashCommand`，
  `router.ts` 改用 `parseInbound`，消除重复解析。
- **CS-3**：删除 `Channel.handleMessage` 的 slash 分支与私有 `handleSlashCommand`，入站解析收敛为
  `{ text, hasText, hasMedia }`；**`/` 开头消息现作为普通消息交给 LLM**（本轮唯一有意的行为变更）。
- **CS-4**：新增 `credential-loader.ts`，`Channel.initSession` 改为委托 `CredentialLoader.ensureSession`；
  `poller.ensureSession` 不再指回 `Channel`。
- **CS-5**：新增 `inbound-handler.ts`（requestId 生成 + contextToken 同步 + `router.dispatch`）；
  `RequestIdGenerator` 由 `InboundHandler` 持有，`poller.onMessage` 指向 `inboundHandler.handle`，
  彻底打破 poller 的两处构造期回调闭环。
- **CS-6**：新增 `create-channel.ts`（`createChannelRuntime` / `ChannelRuntime`）；`Channel` 构造函数
  仅「调用工厂 + 赋字段」，不再 `new` 协作类、不再持有 `sleep` / `mediaStore` / `mediaQueue`。
- **CS-7**：删除仅测试用 / 已死的转发方法（`getTerminalProcessing` / `getTypingTicket` /
  `sendTypingStatus` / `getCurrentRequestId` / `sendText`），D16 三例迁移到 `typing.test.ts`。
- **cs-doc**：把 `docs/ARCHITECTURE.md`、`docs/c4/03a-channel.puml`、`docs/c4/04-class-channel.puml`、
  `tests/README.md` 同步为当前代码事实，并补齐本档案与人工 E2E 清单。

## 最终 `src/channel/` 结构

```
src/channel/
├── channel.ts            # Channel facade：构造委托 createChannelRuntime，仅持有并委托协作类
├── create-channel.ts     # createChannelRuntime：装配协作类并注入回调，返回 ChannelRuntime
├── inbound-parser.ts     # parseInbound：item_list → { text, hasText, hasMedia }（纯函数）
├── inbound-handler.ts    # InboundHandler：requestId 生成 + contextToken 同步 + router.dispatch
├── credential-loader.ts  # CredentialLoader.ensureSession：storage 凭证 → ChannelState
├── state.ts              # ChannelState：凭证 / 注入依赖 / 终端标志（requestId 已迁出）
├── request-id.ts         # RequestIdGenerator（现由 InboundHandler 持有）
├── router.ts             # MessageRouter：turn 编排唯一入口，拥有 TurnQueue
├── queue.ts              # TurnQueue（纯状态）+ SerialTaskQueue（后台串行）
├── polling.ts            # PollingLoop：长轮询 / 退避 / abort-race / generation
├── media-store.ts        # MediaStore：落盘 / 周目录 / 魔数识别
├── typing.ts             # TypingController：ticket 缓存 + keepalive
└── sender.ts             # MessageSender：文本 / 文件出站 + 重试
```

装配路径：`new Channel(deps)` → `createChannelRuntime(deps)` → 构造
`ChannelState / SerialTaskQueue / MediaStore / TypingController / MessageSender / MessageRouter /
InboundHandler / CredentialLoader / PollingLoop` 并互相注入回调 → 返回 `ChannelRuntime`，
`Channel` 仅把各字段赋给自身。`MessageRouter` 拥有 `TurnQueue`；`InboundHandler` 拥有 `RequestIdGenerator`。

## 测试数演进

| 时点 | pass | files | fail | 说明 |
|---|---|---|---|---|
| CS-1 基线（`dev`） | 171 | 20 | 0 | 上一轮（rf-8）收官 |
| CS-1 | 176 | 20 | 0 | 新增 router `dispatch` / `onTurnDone` 用例 |
| CS-2 | 189 | 21 | 0 | 新增 `inbound-parser.test.ts`（15 用例） |
| CS-3 | 184 | 21 | 0 | 移除 slash 拦截，净删 5 例（行为变更） |
| CS-4 | 188 | 22 | 0 | 新增 `credential-loader.test.ts`（4 用例） |
| CS-5 | 194 | 23 | 0 | 新增 `inbound-handler.test.ts`（7 用例） |
| CS-6 | 194 | 23 | 0 | 纯装配重构，测试零改动 |
| CS-7 | 194 | 24 | 0 | 新增 `typing.test.ts`（D16 三例迁移） |
| cs-doc | 194 | 24 | 0 | 纯文档同步，测试零改动 |

最终 `bun run typecheck` 零错误，vendor / lockfile / `package.json` 全程零改动。

## 流程约定

- 每个阶段从 `dev` 切分支 `refactor/<s>-<slug>`，子 Agent 只在自己的 worktree 工作。
- 子 Agent：实现 → `bun install --frozen-lockfile && bun run typecheck && bun run test` → 原子提交到本分支
  → 写 `/tmp/pi-tasks/<s>.result.md` → `tmux wait-for -S task-<s>`。
- 验证 Agent：只读复验本分支 → 写 `/tmp/pi-tasks/<s>.verify-result.md` → `tmux wait-for -S task-<s>-verify`。
- 每阶段结束后，把 `/tmp/pi-tasks/<s>.result.md` / `<s>.verify-result.md` 归档到 `stages/` 下对应文件名。
- **禁止任何子 Agent push**；push 只能由主 Agent 在人类明确指令后执行。
- 验证 PASS 且人工确认后，主 Agent 才 `git merge --ff-only` 合回 `dev`。

## 相关文档

- 本轮人工验收清单：[`e2e-manual-2026-10-12b.md`](./e2e-manual-2026-10-12b.md)
- 架构说明：[`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- C4 图：[`../c4/`](../c4/)
- 上一轮档案：[`../refactor-2026-10-12/README.md`](../refactor-2026-10-12/README.md)、
  [`../refactor-2026-10-11/README.md`](../refactor-2026-10-11/README.md)
- vendor 边界：[`../vendor-constraints.md`](../vendor-constraints.md)
