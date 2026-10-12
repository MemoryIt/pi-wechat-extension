# Task: RF-8 文档归档与同步（应用层加入架构描述）

base: dev
branch: refactor/rf-8-docs
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 171 pass / 20 files / 0 fail
invariant: 不改任何 `src/` 代码、测试、vendor；只改文档
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## goal
把 S1–S7 的成果同步进架构文档与 C4 图，并为本轮补一份人工 E2E 清单：
- `docs/ARCHITECTURE.md` 反映新的 `src/application/` 层、依赖方向、模块职责与关键机制。
- `docs/c4/` 组件图/类图加入 application 层、`RequestIdGenerator`、窄接口；移除已删除的方法。
- 新增 `docs/refactor-2026-10-12/e2e-manual-2026-10-12.md`。
- 完成 `docs/refactor-2026-10-12/README.md` 的收尾（最终架构 / 结果汇总 / 阶段表全部 ✅）。

## 现状（据此更新，勿臆造）
- 新增/变化（S1–S7）：
  - `src/application/`：`reply.ts`（`ReplyService` + `ReplyChannel`、`SettledContext`）、
    `session.ts`（`SessionService` + `SessionUi`/`SessionChannel`）、`types.ts`。
  - `src/bridge/`：`events.ts` 用 `BridgeChannel` 窄接口、`turn.ts` 的 `TurnResolver`、
    `meta.ts` 的 `MetaBuilder`；`session-ui.ts`；`login.ts` 已删除。
  - `src/channel/`：`request-id.ts`（`RequestIdGenerator`）；`ChannelState` 去掉 requestId 字段；
    `Channel` 删除 `configure()` / `cleanupProcessedRequests()`；`polling.ts` 单条 `onMessage` 失败隔离；
    `router.ts` 媒体 ack 失败隔离。
  - `src/adapters/`：明确 ACL（S5）；`docs/vendor-constraints.md` 已存在。
  - 连接状态：`PollingLoop` 在 `start()` 同步 `connecting`（A3）。
- 测试：171 pass / 20 files；vendor 零改动。

## scope（只允许改这些文档）
- `docs/ARCHITECTURE.md`（修改）
- `docs/c4/03-components.puml`（修改：加入 application 组件与关系）
- `docs/c4/04-class-channel.puml`（修改：加 `RequestIdGenerator`；删 `configure`/`cleanupProcessedRequests`；
  注明 bridge 用 `BridgeChannel`/`SendFileChannel` 窄接口）
- `docs/c4/03a-channel.puml`、`docs/c4/03b-ports-adapters.puml`（按需微调；若无需改可不动）
- `docs/refactor-2026-10-12/README.md`（收尾）
- `docs/refactor-2026-10-12/e2e-manual-2026-10-12.md`（新增）

## 具体要求
### 1. `docs/ARCHITECTURE.md`
- 分层图/依赖方向加入 `application/`：
  `index → bridge/application/adapters/ports`；`bridge → application → channel/ports/storage/shared`；
  `application` 不得 import pi / vendor / 具体 `Channel`（用窄接口）。
- 模块职责表补：`application/reply`、`application/session`、`application/types`、
  `bridge/session-ui`、`bridge` 的 `TurnResolver`/`MetaBuilder`/`BridgeChannel`、
  `channel/request-id`。
- 关键机制补：`agent_settled` 决策在 `ReplyService`；会话生命周期在 `SessionService`；
  `BridgeChannel`/`SendFileChannel`/`ReplyChannel`/`SessionChannel` 窄接口；requestId 由
  `RequestIdGenerator` 生成；A3 的 `connecting`；F6 的单条消息失败隔离 + 媒体 ack 失败隔离。
- 引用 `docs/vendor-constraints.md`（vendor 边界）。
- 移除/修正过时表述（`WechatEngine`、`bridge/login.ts`、模块级 `setPi/setConfig`、模块级可变状态等）。

### 2. C4
- `03-components.puml`：`plugin` 边界内新增 `Component(application, ...)`；关系
  `index → application`、`bridge → application`、`application → channel/ports/storage`；
  约束 note 增补「bridge 只做事件翻译、application 承载用例、application 不依赖 pi/vendor」。
- `04-class-channel.puml`：新增 `RequestIdGenerator` 类与 `Channel ..> RequestIdGenerator`；
  从 `Channel` 类中删除 `configure` / `cleanupProcessedRequests`；更新 `Channel` 组合/依赖说明。
- 保持 PlantUML 语法自洽（`@startuml`/`@enduml`、宏 include、`Rel`/`Component` 配对）。

### 3. `e2e-manual-2026-10-12.md`
- 参照 `docs/refactor-2026-10-11/e2e-manual-2026-10-11.md` 的结构（A–K 分段 + 通过标准 + 排障），
  针对本轮补充：
  - **A3**：重启后 `/wechat status` 先显示 `connecting`、首次 getUpdates 后 `connected`。
  - **F6（重点）**：连发 3 张图片再发 1 条文本 → 文本应即时响应；日志无
    `Failed to handle message` / `Media ack failed` 重投循环；`sync.json` cursor 持续推进。
  - 应用层重构回归：`/wechat login|status|start|stop|logout` 行为不变；微信回复只发一次；
    D1/D2/D5 语义（成功才标记、失败可重试、队列释放）。
  - 其余沿用上一轮条目（登录/持久化/双向文本/typing/媒体/文件/命令/配置）。

### 4. `docs/refactor-2026-10-12/README.md`
- 阶段表 S1–S8 全部标 ✅（S8 标「进行中」直到验证通过）。
- 补「最终架构」与「结果汇总」：测试 129 → 171；vendor 零改动；新增 `application/`、`request-id`、
  ACL/vendor-constraints、A3/F6 修复。

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（171 pass / 20 files），
      证明本轮纯文档、未碰代码
- [ ] `docs/ARCHITECTURE.md` 含 `src/application/` 层与更新后的依赖方向；无过时表述
- [ ] `docs/c4/03-components.puml` 含 `application` 组件；`docs/c4/04-class-channel.puml` 含
      `RequestIdGenerator` 且不再有 `configure`/`cleanupProcessedRequests`
- [ ] `docs/refactor-2026-10-12/e2e-manual-2026-10-12.md` 存在，含 A3 与 F6 重点项
- [ ] `docs/refactor-2026-10-12/README.md` 阶段表与结果汇总更新
- [ ] 过时引用清查：
      `rg "WechatEngine|bridge/login|lastRequestIdMs|setPi\(|setConfig\(.*global" docs/ARCHITECTURE.md docs/c4 docs/refactor-2026-10-12/README.md`
      无命中（历史档案 `docs/refactor-2026-10-11/**` 除外）
- [ ] `git diff dev...HEAD --stat` 仅限 `docs/**`（不得动 `src/`、`tests/`、`package.json`、`bun.lock`）
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 `src/**`、`tests/**`、`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`、
  `package.json`、`bun.lock`
- 不得修改历史档案 `docs/refactor-2026-10-11/**`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支

## report
完成后写 `/tmp/pi-tasks/rf-8.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-8`
