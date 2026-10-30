# PA-6 验证报告

- verdict: **PASS**
- base-branch: `refactor/pa-6-composition-root`
- base(dev): `8c7eb7f9883b13bf62f58a9cdf5042301977bd86`
- HEAD: `cecc37cb313629afa5f9107131d7815e37d1964a`
- `HEAD^ == dev`（parent 即为 dev），`dev..HEAD` = 1 个原子提交，工作树 clean
- verifier: 只读；未修改代码、未提交、未 push（仅 `bun install` 校验 lockfile 与写本报告）

---

## 1. 构建 / 测试（check 1 & 2）—— PASS

命令链：
```
bun install --frozen-lockfile && bun run typecheck && bun run test
```
结果 `CHAIN_EXIT=0`：

| 项 | 结果 |
| --- | --- |
| install | `Checked 131 installs across 139 packages (no changes) [4.00ms]` |
| typecheck | `tsc --noEmit` 无输出，exit 0 |
| test | **127 pass / 0 fail / 364 expect() calls / Ran 127 tests across 15 files** |

基线核对（`git show dev:<file> | grep -cE '^\s*test\('` 逐文件计数）：
```
tests/bridge/event-wiring.test.ts   9  (dev 8, +1 组合根隔离)
tests/bridge/meta.test.ts           2  = 2
tests/bridge/turn-state.test.ts     6  = 6
tests/bridge/turn.test.ts           8  = 8
tests/engine/engine.test.ts        21  = 21
tests/engine/media-store.test.ts   12  = 12
tests/engine/queue.test.ts          9  = 9
tests/engine/router.test.ts         9  = 9
tests/integration/channel-flow.test.ts 5 = 5
tests/unit/adapters.test.ts        19  = 19
tests/unit/channel-state.test.ts    4  = 4
tests/unit/config.test.ts           5  = 5
tests/unit/dependencies.test.ts     2  = 2
tests/unit/logger.test.ts          10  = 10
tests/unit/storage.test.ts          6  = 6
------------------------------------------------
dev 合计 126 → HEAD 合计 127（净 +1；文件数 15=15）
```
与 `pa-6.result.md` 的 `test-changes` **完全一致**：仅 `event-wiring` +1（隔离用例），`turn-state` 6→6 仅改名。无 `test.skip/todo/only`。

## 2. 边界 / 越界（check 3）—— PASS

`git diff --name-status dev HEAD`（全部改动，9 个文件）：
```
M src/bridge/commands.ts
M src/bridge/events.ts
M src/bridge/login.ts
M src/bridge/tool-send-file.ts
M src/engine/wechat.ts
M src/index.ts
M tests/bridge/event-wiring.test.ts
M tests/bridge/turn-state.test.ts
M tests/setup/bridge-harness.ts
```
- **vendor 目录 diff 为空**：`git diff dev HEAD -- api auth cdn media messaging util types` → 空（`EXIT=0`、无输出）。本仓 vendor 代码位于 `api/ auth/ cdn/ media/ messaging/ util/ types/`（无字面 `vendor/` 目录）。
- `package.json` / `bun.lock` / `tsconfig.json` diff 为空（未新增依赖）。
- `docs/` 未改（result 声明文档同步留给 S8）；`tests/setup/mocks.ts`、`fake-pi.ts`、`engine-harness.ts`、`tests/engine/engine.test.ts` diff 为空。
- 无 untracked（`git status --porcelain` 空）。

## 3. 单例 / 模块函数移除（check 5 & 6）—— PASS

```
rg "export const engine\b|export function setPi|export function setConfig" src   # exit 1（无匹配）
rg "engine/wechat" src                                                            # exit 1（无匹配）
rg "from ['\"].*engine/wechat" src tests                                          # exit 1（无匹配）
rg "\bsetPi\b" src tests                                                          # 仅 wechat.ts 注释「不再导出 setPi…」
rg "from ['\"].*engine/wechat|require\(.*engine/wechat" src tests                 # exit 1（无匹配）
```
- `src/index.ts` 无 `./engine/wechat` import；bridge 四个文件全部改为 `type { Channel } from "../channel/channel.js"`。
- `src/engine/wechat.ts` diff：删除 `setPi` / `setConfig` 函数与 `export const engine = new WechatEngine()`；保留 `WechatEngine` 类、`createWechatEngine`、`WechatHost`、`WechatConfig`、`ConnectionState`。
- 注：`setConfig` 仍作为 **Channel / WechatEngine 的实例方法**存在（符合 acceptance 只针对模块函数）。`docs/ARCHITECTURE.md`、`c4/*.puml` 仍引用旧 `engine/setPi`，属 S8 文档同步范围、非本阶段 scope。

## 4. index.ts 组合根（check 7）—— PASS

`src/index.ts`（全文 53 行）逐项：
- `export interface ExtensionDeps { channel?: Channel; auth?: WechatAuth }`
- `function piToHost(pi): PiHost` — 转发 `appendEntry / sendUserMessage / sendMessage`（与旧 `setPi` 完全等价）
- `export function createExtension(deps: ExtensionDeps = {})` → 返回 `(pi) => { const channel = deps.channel ?? new Channel(); channel.setHost(piToHost(pi)); const auth = deps.auth ?? createWechatAuth(); pi.registerTool(createSendFileTool(channel)); registerCommands(pi, channel, auth); registerBridge(pi, channel); }`
- `export default createExtension()`
- 显式 `new Channel()` + `createWechatAuth()` + `piToHost` 均在；无模块级 Channel。

## 5. bridge 注入驱动（check 8）—— PASS

```
registerBridge(pi, channel)                 # src/index.ts:49, bridge/events.ts:31
registerCommands(pi, channel, auth)         # src/index.ts:48, bridge/commands.ts:13
performWechatLogin(ctx, channel, auth)      # commands.ts:25, login.ts:18（auth 无默认值）
createSendFileTool(channel)                 # index.ts:47, tool-send-file.ts:18
```
- `src/bridge/*` diff 为**纯机械替换**：`startTypingKeepalive→startTyping`、`stopTypingKeepalive→stopTyping`、`sendMessageWithRetry→sendReply`、`sendFileToUser→sendFile`、`setConfig(...)→channel.setConfig(...)`、`engine.*→channel.*`。
- 无 `setPi` / 模块级 `setConfig` 调用；`registerBridge`/`registerCommands` 不再 import `engine/wechat`。
- 方法映射与 `Channel` 实际 API 逐一核对无误（`setNotifier/setConfig/startPolling/stopPolling/reset/setTerminalProcessing/getTerminalProcessing/startTyping/stopTyping/isRequestProcessed/markRequestProcessed/sendReply/onAiDone/connectionState/sendFile` 均存在）。
- 命令 handler 全部保留（login/status/start/stop/logout）；事件订阅全部保留（session_start/session_shutdown/input/before_agent_start/message_start/message_end/agent_end/agent_settled）。

## 6. bridge-harness（check 9 前半）—— PASS

`tests/setup/bridge-harness.ts`：
- **无 `mock.module`**（`rg "mock\.module|engine/wechat" tests/setup/bridge-harness.ts` → exit 1）；删除 `BridgeEngine/createBridgeEngine/resetBridgeEngine/installBridgeMocks/setPiMock/setConfigMock/loadIndex` 及对 `src/engine/wechat.js` 的双份 mock。
- 新增 `createBridgeChannel()`（含 `setConfig/setNotifier/startPolling/stopPolling/reset/startTyping/stopTyping/onAiDone/isRequestProcessed/markRequestProcessed/sendReply/sendFile/getTerminalProcessing/setTerminalProcessing/connectionState` + terminal/processed 内部状态）。
- `authMock = { startQr, waitForLogin }`。
- `loadExtension({ channel, auth })` 走 `(await import("../../src/index.ts")).createExtension({ channel, auth })`。
- 仍只用 `installBaseMocks()` 固定 `agentDir`（pi SDK / typebox / util logger）。

## 7. 隔离性（check 10）—— PASS

- 代码论证：`createExtension(deps)` 返回的闭包内 `const channel = deps.channel ?? new Channel()`，每次调用新建实例；默认 `export default createExtension()` 不含模块级可变单例。
- 测试证据：`event-wiring.test.ts` 新用例「组合根：两次 createExtension()(pi) 创建的 channel 互相独立」用 `Channel.prototype.setHost` 探针收集 `this`，断言 `seen.length===2` 且 `seen[0] !== seen[1]`，实跑 **pass**。

## 8. WechatEngine 保留（check inside acceptance）—— PASS

```
export class WechatEngine        src/engine/wechat.ts:57
export function createWechatEngine  src/engine/wechat.ts:184
export type WechatHost = PiHost  :30   export type WechatConfig :32   export type { ConnectionState } :22
```
`bun test --isolate tests/engine/engine.test.ts` → **21 pass / 0 fail / 60 expect() calls**；该文件 diff 为空（未改）。

## 9. 关键回归语义（check 11）—— PASS

标签全部仍在，且断言逐条未弱化（仅 `engine.*` → `channel.*` 改名）。实跑两文件：**15 pass / 0 fail**。

| 用例 | 文件 | 结果 |
| --- | --- | --- |
| D1 去重命中 early-return 仍调用 `onAiDone` | turn-state | pass |
| D2 发送失败不 markRequestProcessed | event-wiring | pass |
| D4 前一微信 turn 回复不被后一终端 turn 覆盖 | turn-state | pass |
| D4 wechat_meta 判定（2 例） | turn-state | pass |
| D5 agent_end 释放 terminal / agent_settled 兜底（2 例） | event-wiring | pass |
| D11 登录日志不出现明文 botToken | event-wiring | pass |
| D17 订阅 agent_settled | event-wiring | pass |
| D18 非 assistant 不停止 typing | event-wiring | pass |
| D19 不用空 render 覆盖 footer | event-wiring | pass |
| D20 /wechat start 同时 `channel.setConfig` | event-wiring | pass |
| D21 buildMetaInfo 增量累计、不重复读旧 entry（`$0.300`） | turn-state | pass |

expect 行比对：event-wiring dev 12 条 → HEAD 14 条（原 12 条全部保留 + 新增 2 条隔离断言）；turn-state dev 12 条 → HEAD 12 条（逐条语义对应）。无删除/弱化。

## 10. 提交（check 12）—— PASS（含备注）

```
cecc37c refactor(index): 组合根显式组装 Channel + Auth（createExtension）
  pi-bot <pi-bot@local>
  body 详列 index/engine/bridge/test 变更与行为不变声明
```
- 单个原子提交；本阶段 index↔bridge↔test 存在硬类型耦合（例如 index 传 `Channel` 而旧 `registerBridge` 要求 `WechatEngine`，中间态无法通过 `tsc`），合并为一个全绿提交合理；result 已说明。
- conventional commit，scope `index`，message 规范；未 push；未改 base（`HEAD^ == dev`）。

---

## 备注（非阻塞）

1. 任务书中「vendor 目录」在本仓实际为 `api/ auth/ cdn/ media/ messaging/ util/ types/`；以上均零 diff。
2. `docs/ARCHITECTURE.md` / `docs/c4/03-components.puml` 仍引用 `engine` 单例与 `setPi`，属 S8 文档同步范围，result 已声明，非本阶段 scope。
3. `tests/setup/mocks.ts` 仍 `mock.module` pi SDK / typebox / `util/logger.js`，是既有基础设施约定，非微信边界，且不在 mock 引擎单例的范围内。

## 命令清单

```
bun install --frozen-lockfile && bun run typecheck && bun run test    # exit 0, 127 pass / 15 files / 0 fail / 364 expect
git diff dev HEAD --name-status                                       # 9 files, no out-of-scope
git diff dev HEAD --stat -- api auth cdn media messaging util types   # 空
rg "export const engine\b|export function setPi|export function setConfig" src   # 无匹配
rg "engine/wechat" src                                                # 无匹配
rg "mock\.module|engine/wechat" tests/setup/bridge-harness.ts         # 无匹配
bun test --isolate tests/bridge/event-wiring.test.ts tests/bridge/turn-state.test.ts   # 15 pass / 0 fail
bun test --isolate tests/engine/engine.test.ts                        # 21 pass / 0 fail
git log --oneline dev..HEAD                                           # 1 commit（HEAD^ == dev）
```
