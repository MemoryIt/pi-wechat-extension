status: done
branch: refactor/pa-6-composition-root
commits:
- cecc37cb313629afa5f9107131d7815e37d1964a refactor(index): 组合根显式组装 Channel + Auth（createExtension）
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（127 pass / 15 files / 0 fail / 364 expect calls）
test-changes: 基线 126 → 127（净 +1；文件数 15 → 15）。明细：
  - tests/bridge/event-wiring.test.ts 8 → 9（+1：组合根隔离用例「两次 createExtension()(pi) 创建的 channel 互相独立」，
    以 Channel.prototype.setHost 探针收集实例，断言两次调用分别落在不同 Channel）。
  - tests/bridge/turn-state.test.ts 6 → 6（仅把假 engine 观测点改为注入的假 Channel 方法名；断言语义不变）。
  - tests/setup/bridge-harness.ts：删除 BridgeEngine/createBridgeEngine/resetBridgeEngine/
    installBridgeMocks/setPiMock/setConfigMock/loadIndex 与对 src/engine/wechat.js 的 mock.module；
    新增 createBridgeChannel/resetBridgeChannel/authMock(startQr/waitForLogin)/loadExtension({channel,auth})。
  - 既有断言全部保留，仅机械映射：startTypingKeepalive→startTyping、stopTypingKeepalive→stopTyping、
    sendMessageWithRetry→sendReply、sendFileToUser→sendFile、setConfigMock→channel.setConfig。
scope-check: 未越界。改动清单（vs dev）：
  - 修改 src/index.ts（重写为显式组合根；新增导出 createExtension(deps?) + default createExtension()）
  - 修改 src/engine/wechat.ts（删除模块级 engine 单例 / setPi / setConfig；WechatEngine 类 / createWechatEngine /
    WechatHost / WechatConfig / ConnectionState 导出保留）
  - 修改 src/bridge/commands.ts、events.ts、login.ts、tool-send-file.ts（改为注入 Channel / WechatAuth，方法名映射）
  - 修改 tests/setup/bridge-harness.ts、tests/bridge/event-wiring.test.ts、tests/bridge/turn-state.test.ts
  - 未改 vendor（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - 未改 package.json / bun.lock / tsconfig.json；未 push；未改 base（dev 为 HEAD 祖先）
acceptance:
  - [x] `bun run typecheck && bun run test` 全绿，127 ≥ 基线 126 + 本阶段新增 1
  - [x] `rg "export const engine\b|export function setPi|export function setConfig" src` 为空
  - [x] `rg "engine/wechat" src` 为空（index/bridge 不再引用单例模块）
  - [x] tests/setup/bridge-harness.ts 无对 src/engine/wechat.js 的 mock.module（且无任何 mock.module）
  - [x] src/index.ts 提供 createExtension(deps?) 且 export default createExtension()；bridge 由注入驱动
  - [x] 两次 createExtension()(pi) 互不共享 channel（event-wiring.test.ts 隔离用例）
  - [x] WechatEngine 类与 createWechatEngine 仍导出；tests/engine/engine.test.ts 仍通过
  - [x] vendor 目录零 diff
  - [x] 关键回归语义仍覆盖：D11/D17/D18/D19/D20/D2/D5/D1/D4/D21
  - [x] 提交原子、message 规范（组合根 DI 为一个逻辑变更，src+tests 同步迁移以保持提交全绿）
design:
  - index.ts：`ExtensionDeps { channel?; auth? }`；`createExtension(deps)` 返回 `(pi) => { channel = deps.channel ?? new Channel();
    channel.setHost(piToHost(pi)); auth = deps.auth ?? createWechatAuth(); registerTool/registerCommands/registerBridge }`；
    `piToHost` 转发 appendEntry/sendUserMessage/sendMessage。默认实例在闭包内每次调用新建 Channel，天然隔离。
  - bridge 侧签名：registerBridge(pi, channel)、registerCommands(pi, channel, auth)、
    performWechatLogin(ctx, channel, auth)、createSendFileTool(channel)。
  - WechatEngine 退化为仅保留类与工厂（S7 删除），其内部仍委托 Channel；旧模块级函数不再存在。
notes: |
  - 任务书建议的 4 段提交（index / engine / bridge / test）在本阶段存在硬性交叉依赖：任一单层提交都会让另一层
    类型不成立（index 传 Channel ↔ bridge 要求 Channel ↔ test harness 注入）。为使每个提交原子且最终 HEAD 全绿，
    合并为一个逻辑提交（组合根 DI），并在同一提交内同步迁移 harness/断言。
  - 默认 createExtension() 的隔离通过「闭包内 new Channel()」保证；测试用 prototype 探针证明两次注册命中不同实例。
  - 未新增依赖；docs/ARCHITECTURE.md 中的 engine/* 路径同步留给 S8。
