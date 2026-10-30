# Task: PA-9 把 adapter 组装上移到 index，消除 channel → adapters 依赖

base: dev
branch: refactor/pa-9-index-assembles-adapters
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 127 pass / 15 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公开行为、持久化格式、redact 规则不得改变
commit: 原子提交；禁止 push；禁止改 base 分支

## goal
消除 `channel → adapters` 的过渡依赖：让 **`src/index.ts` 负责组装 adapters + ChannelState**，
`Channel` 只依赖 `ports/`；`src/channel/*` 不再 import `../adapters/*`。

## 背景
当前 `src/channel/channel.ts` 在未注入 ports 时缺省 `createWechatInbound/Outbound/Media`，
因此 import adapters（核心依赖外层，违反依赖倒置）。outbound adapter 需要 `getCredentials`，
而凭证在 `ChannelState`，故需把 state 创建上移到 index 并与 adapter 共享。

## scope
- prod（修改）：
  - `src/channel/state.ts`：新增 `getCredentials(): WechatCredentials | null` 与 `getOpts(): WechatApiOpts | null`（从原 Channel 私有方法迁移；仅依赖 state 字段）
  - `src/channel/channel.ts`：
    - **删除** `import { createWechatInbound/Outbound/Media } from "../adapters/*"`
    - `ChannelPorts` 的 `inbound/outbound/media` 改为**必填**；`ChannelDeps.ports` **必填**（`state` 仍可选，缺省 `new ChannelState()`）
    - 删除缺省 adapter 构造；直接使用 `deps.ports`
    - 私有 `getCredentials()`/`getCurrentOpts()` 改走 `this.state.getCredentials()`/`this.state.getOpts()`；`canSend` 同理
  - `src/index.ts`：显式组装
    ```ts
    const logger = createLogger({ isDebugEnabled: () => isDebugEnabled() });
    const state = new ChannelState();
    const ports = {
      inbound: createWechatInbound(),
      outbound: createWechatOutbound({ getCredentials: () => state.getCredentials(), logger }),
      media: createWechatMedia({ log: (m) => logger.debug(m), errLog: (m) => logger.error(m) }),
    };
    const channel = deps.channel ?? new Channel({ state, ports, logger });
    ```
- tests（更新构造，保持断言语义）：
  - `tests/setup/channel-harness.ts`、`tests/channel/channel.test.ts`、`tests/integration/channel-flow.test.ts`：
    `new Channel({ state: new ChannelState(), ports: {...}, host, config, logger?, sleep? })`
- docs（修改）：
  - `docs/ARCHITECTURE.md`：删除「channel 缺省构造 adapters / 过渡状态 / 待迁 index」的表述，改为「index 组装 adapters + ChannelState；channel 只依赖 ports」
  - `docs/c4/03-components.puml`、`docs/c4/03b-ports-adapters.puml`：如含过渡标注则更新为最终依赖方向

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（127）
- [ ] `rg "adapters" src/channel` 为空（channel 不再 import adapters）
- [ ] `src/index.ts` 组装 4 件事：`ChannelState` + 3 个 adapter（inbound/outbound/media）+ `Channel`（outbound 的 `getCredentials` 读同一 state）
- [ ] `ChannelPorts.{inbound,outbound,media}` 与 `ChannelDeps.ports` 为必填；无缺省 adapter 构造
- [ ] 行为不变：凭证/typing/sender/媒体/复位语义与 S8 一致
- [ ] docs 中无「过渡 / 待迁 index / channel 缺省构造 adapters」残留
- [ ] vendor 目录零 diff；`src/bridge/**` 零 diff
- [ ] 关键回归用例仍全绿：D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9 + 集成用例
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改变运行时行为/事件时序
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(channel): ChannelState 提供 getCredentials/getOpts`
2. `refactor(channel): Channel 只依赖 ports（移除缺省 adapters 构造，ports 必填）`
3. `refactor(index): 组合根组装 ChannelState + adapters`
4. `test: 构造改为注入 state + ports`
5. `docs: 更新依赖方向（index 组装 adapters）`

## report
完成后写 `/tmp/pi-tasks/pa-9.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-9`
