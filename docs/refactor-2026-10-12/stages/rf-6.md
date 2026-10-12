# Task: RF-6 Channel 瘦身 + ChannelState 收敛（保守范围）

base: dev
branch: refactor/rf-6-channel-slim
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 163 pass / 18 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；公共对外行为 / 文案 / 持久化 / 端口签名不变；连接状态真相源仍在 PollingLoop
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 背景与范围说明
S1–S5 后，`Channel` 的真实外部调用面已很小（`application/` 已用 `ReplyChannel`/`SessionChannel`
窄接口；`bridge/` 只用 typing/terminal/notifier；`tool-send-file` 只用 `sendFile`）。
本轮**不做大拆解**（协作者已拆好），只做三件低风险、可验证的收敛：
1. 删除已彻底无人调用的公共方法（src + tests 均为 0 调用）。
2. 为 `bridge` 消费方引入窄接口，停止 `bridge` 依赖具体 `Channel` 类型。
3. 把 `requestId` 追踪从 `ChannelState` 抽到独立的 `RequestIdGenerator`，使 `ChannelState`
   只剩「凭证 + 运行期依赖 + 终端标志」。

## scope
- prod（新增）：
  - `src/channel/request-id.ts`（`RequestIdGenerator`）
- prod（修改）：
  - `src/channel/channel.ts`：
    - 删除公共方法 `configure()` 与 `cleanupProcessedRequests()`（已确认零调用）
    - 内部持有 `private readonly requestId = new RequestIdGenerator()`；私有 `generateRequestId()`
      改为委托 `this.requestId.next()`（**保持私有方法名与签名不变**，D13 用例不改）
    - 为公共 API 加一段分组注释（facade for bridge / application / tests）
  - `src/channel/state.ts`：删除 `lastRequestIdMs` / `requestIdSeq` 两个字段及其在 `resetSession()`
    中的重置；更新文件头注释（requestId 追踪已迁出）
  - `src/bridge/events.ts`：定义并使用窄接口 `BridgeChannel`（`setNotifier` / `startTyping` /
    `stopTyping` / `setTerminalProcessing`），`BridgeDeps.channel` 类型改为 `BridgeChannel`
  - `src/bridge/tool-send-file.ts`：`createSendFileTool(channel)` 参数类型改为窄接口
    `{ sendFile(localPath: string): Promise<void> }`
  - `src/index.ts`：仅类型层面适配（传入具体 `Channel`，结构化满足窄接口）
- tests（修改/新增）：
  - `tests/unit/channel-state.test.ts`：删除对已移除字段 `lastRequestIdMs` / `requestIdSeq` 的断言
    （字段已不存在；其不变量转由 request-id 测试覆盖）
  - `tests/channel/request-id.test.ts`（新增）：同毫秒唯一、序号递增、跨毫秒归零、格式长度
  - `tests/channel/channel.test.ts`：D13 用例**保持不变**（仍走 `generateRequestId()`）

## 不变量（必须满足）
- `ChannelState` 字段收敛为：`accountId / userId / contextToken / config / host / notifier /
  isTerminalMessageProcessing`；`resetSession()` 清空凭证 + 终端标志，保留 config/host/notifier。
- `Channel.generateRequestId()` 仍是私有方法、签名不变；产出格式仍为
  `YYMMDDHHMMSSmmm` + 3 位同毫秒序号；同一实例同毫秒唯一。
- `Channel` 公共对外方法（除被删的两个）签名与行为不变；连接状态 getter 仍委托 PollingLoop。
- `bridge/**` 不再 import `../channel/channel.js`（改为窄接口类型）。

## test-plan
- [ ] `tests/channel/request-id.test.ts`：
  - 同一 `now` 连续两次 → 两个 id 不同、且后缀按 `000/001` 递增
  - `now` 变化 → 序号归零
  - id 格式 = 15 位时间戳 + 3 位序号（总长 18）
- [ ] `tests/unit/channel-state.test.ts`：移除 lastRequestIdMs/requestIdSeq 断言后其余语义不变
- [ ] `tests/channel/channel.test.ts` D13：不改动、仍通过

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 163
- [ ] `rg "configure\(|cleanupProcessedRequests" src/channel/channel.ts tests` 无命中
- [ ] `rg "lastRequestIdMs|requestIdSeq" src tests` 无命中
- [ ] `src/channel/request-id.ts` 新增 `RequestIdGenerator`；`src/channel/channel.ts` 委托它
- [ ] `rg "channel/channel" src/bridge` 无命中（bridge 不再依赖具体 Channel）
- [ ] D13 既有用例通过且未改动
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{channel,state,request-id}.ts`、
      `src/bridge/{events,tool-send-file}.ts`、`src/index.ts`、`tests/**`
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、
  `src/channel/` 下 `channel.ts`/`state.ts`/`request-id.ts` 以外的文件
  （`polling/queue/router/media-store/typing/sender` 一律不动）
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得改变任何对外行为；不得删除/削弱既有测试断言（移除已删字段的断言属同步迁移，需在 result 说明）

## report
完成后写 `/tmp/pi-tasks/rf-6.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-6`
