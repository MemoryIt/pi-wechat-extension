# Task: PA-6 组合根显式 DI：index 组装 Channel + Auth，移除单例/setPi/setConfig，bridge 注入

base: dev
branch: refactor/pa-6-composition-root
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 126 pass / 15 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公开行为、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
把组合根收敛到 `src/index.ts`：显式创建 `PiHost` + `Channel` + `WechatAuth` 并注入 bridge；
**移除模块级 `engine` 单例、`setPi`、`setConfig`**；bridge 改依赖 `Channel`/`WechatAuth` 注入（不再 import 单例）。
`WechatEngine` 类本阶段**保留**（S7 再删除），但其单例与模块级函数移除。

## scope
- prod（修改）：
  - `src/index.ts`（重写为显式组装；提供 `createExtension(deps?)` + `export default createExtension()`）
  - `src/engine/wechat.ts`（**删除** `engine` 单例、`setPi`、`setConfig`；保留 `WechatEngine` 类、`createWechatEngine`、`WechatHost`/`WechatConfig`/`ConnectionState` 导出）
  - `src/bridge/events.ts`（签名 `registerBridge(pi, channel: Channel)`；`setConfig`→`channel.setConfig`；`startTypingKeepalive/stopTypingKeepalive`→`channel.startTyping/stopTyping`；`sendMessageWithRetry`→`channel.sendReply`；去掉 `setConfig` import）
  - `src/bridge/commands.ts`（签名 `registerCommands(pi, channel, auth: WechatAuth)`；`channel.setConfig`；登录调用 `performWechatLogin(ctx, channel, auth)`）
  - `src/bridge/login.ts`（签名 `performWechatLogin(ctx, channel, auth)`；去掉 `createWechatAuth` import）
  - `src/bridge/tool-send-file.ts`（`createSendFileTool(channel)`，调用 `channel.sendFile`）
- tests：
  - `tests/setup/bridge-harness.ts`（**核心改造**：假 `Channel`（Channel API）+ 假 `auth`；`loadExtension({channel,auth})` 走 `createExtension`；**删除对 `src/engine/wechat.js` 的 mock.module**）
  - `tests/bridge/event-wiring.test.ts`、`tests/bridge/turn-state.test.ts`（改用注入 fakes；方法名/断言随 Channel API 调整）

## index.ts 设计
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Channel } from "./channel/channel.js";
import type { WechatAuth } from "./ports/auth.js";
import type { PiHost } from "./ports/pi-host.js";
import { createWechatAuth } from "./adapters/auth.js";
import { createSendFileTool } from "./bridge/tool-send-file.js";
import { registerCommands } from "./bridge/commands.js";
import { registerBridge } from "./bridge/events.js";

export interface ExtensionDeps { channel?: Channel; auth?: WechatAuth; }
function piToHost(pi: ExtensionAPI): PiHost { /* appendEntry/sendUserMessage/sendMessage 转发 */ }

export function createExtension(deps: ExtensionDeps = {}) {
  return (pi: ExtensionAPI) => {
    const channel = deps.channel ?? new Channel();
    channel.setHost(piToHost(pi));
    const auth = deps.auth ?? createWechatAuth();
    pi.registerTool(createSendFileTool(channel));
    registerCommands(pi, channel, auth);
    registerBridge(pi, channel);
  };
}
export default createExtension();
```
- 不再有模块级 `engine`/`setPi`/`setConfig`；`default(pi)` 每次调用创建独立 `Channel`（隔离）。
- `createExtension` 供测试注入 fake channel/auth。

## bridge 方法名映射（机械替换）
`startTypingKeepalive`→`channel.startTyping`，`stopTypingKeepalive`→`channel.stopTyping`，
`sendMessageWithRetry`→`channel.sendReply`，`sendFileToUser`→`channel.sendFile`；
`setConfig(...)`→`channel.setConfig(...)`；其余 `setNotifier/startPolling/stopPolling/reset/
setTerminalProcessing/getTerminalProcessing/isRequestProcessed/markRequestProcessed/onAiDone/connectionState` 同名。

## bridge-harness 目标 API
- `createBridgeChannel()`：返回假 `Channel`（含 `setConfig`/`setNotifier`/`startPolling`/`stopPolling`/`reset`/
  `startTyping`/`stopTyping`/`onAiDone`/`isRequestProcessed`/`markRequestProcessed`/`sendReply`/`sendFile`/
  `getTerminalProcessing`/`setTerminalProcessing`/`connectionState`），带 terminal/processed 内部状态。
- `authMock`：`{ startQr, waitForLogin }` 两个 mock。
- `loadExtension({ channel, auth })`：`(await import("../../src/index.ts")).createExtension({ channel, auth })`。
- **删除** `installBridgeMocks` 与对 `src/engine/wechat.js` 的 `mock.module`；`installBaseMocks()` 仍用于固定 agentDir。
- 可保留 `setConfigMock` 语义：改为断言 `channel.setConfig`（即假 Channel 的方法）。

## test-migration
bridge 测试从「mock engine/wechat 模块」迁移到「`createExtension` 注入 fake channel + auth」。
断言语义保持不变（D11/D17/D18/D19/D20/D2/D5/D1/D4/D21 等）。

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（126）+ 本阶段新增
- [ ] `rg "export const engine\b|export function setPi|export function setConfig" src` 为空
- [ ] `rg "engine/wechat" src` 为空（index/bridge 不再引用单例模块）
- [ ] `tests/setup/bridge-harness.ts` 无对 `src/engine/wechat.js` 的 `mock.module`
- [ ] `src/index.ts` 提供 `createExtension(deps?)` 且 `export default createExtension()`；bridge 由注入驱动
- [ ] 两次 `createExtension()(pi)` 互不共享 channel（有测试或可论证）
- [ ] `WechatEngine` 类与 `createWechatEngine` 仍导出（S7 再删）；`engine.test.ts` 仍通过
- [ ] vendor 目录零 diff
- [ ] 关键回归语义仍覆盖：D11/D17/D18/D19/D20/D2/D5/D1/D4/D21
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改 bridge 的事件时序/行为语义（仅换注入与方法名）
- 不得删除 `WechatEngine` 类（S7 再做）
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(index): 组合根显式组装 Channel + Auth（createExtension）`
2. `refactor(engine): 移除单例 engine / setPi / setConfig`
3. `refactor(bridge): 经注入的 Channel/WechatAuth 工作`
4. `test(bridge): harness 改为注入 fake channel/auth`

## report
完成后写 `/tmp/pi-tasks/pa-6.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-6`
