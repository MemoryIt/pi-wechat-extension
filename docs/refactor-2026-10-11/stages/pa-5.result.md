status: done
branch: refactor/pa-5-channel-split
commits:
- aecc4b5ed4490b6488d6dca90074d59a5ca94923 refactor(channel): 移动协作类到 channel/ 并更新 import
- 69b67c13ddc1f6396e4b2bf45004c23925d94cfa refactor(channel): 新增 Channel 粗粒度编排器
- 4f18d67869247d9517c9af596d33e23b7440c24d refactor(engine): WechatEngine 退化为委托 Channel 的薄门面
- 8c7eb7f9883b13bf62f58a9cdf5042301977bd86 test(channel): 新增通道集成测试
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（126 pass / 15 files / 0 fail / 362 expect calls）
test-changes: 基线 121 → 126（净 +5；文件数 14 → 15）。明细：
  - tests/integration/channel-flow.test.ts 0 → 5（新增：入站文本（含 onAiDone 排空）、入站媒体（ack + 后台下载 + wechat_media）、typing keepalive、出站 sendReply/sendFile、reset 清凭证但保留 config/host/notifier）
  - 既有 14 个测试文件用例数不变；tests/engine/{queue,media-store,router}.test.ts 仅 import 路径改到 src/channel/*；tests/engine/engine.test.ts 仅私有观测点改走 engine.channel.*，断言语义不变
scope-check: 未越界。改动清单（vs dev）：
  - 新增 src/channel/channel.ts（Channel + ChannelDeps + ChannelPorts）
  - 移动（git mv，纯移动，router 仅宿主类型 + import）：
    src/engine/polling.ts → src/channel/polling.ts
    src/engine/queue.ts → src/channel/queue.ts
    src/engine/router.ts → src/channel/router.ts（WechatHost → ../ports/pi-host.js 的 PiHost）
    src/engine/media-store.ts → src/channel/media-store.ts
    src/engine/typing.ts → src/channel/typing.ts
    src/engine/sender.ts → src/channel/sender.ts
  - 修改 src/engine/wechat.ts（薄门面：仅持有 private channel，全公共成员委托；导出/签名不变）
  - 修改 tests/engine/{engine,media-store,queue,router}.test.ts
  - 新增 tests/integration/channel-flow.test.ts
  - src/engine/ 仅剩 wechat.ts；`rg 'from "\.\./engine' src/channel` 为空
  - vendor 目录（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - src/bridge/* diff vs dev 为空
acceptance:
  - [x] typecheck + test 全绿，126 ≥ 121 + 新增 5
  - [x] `src/channel/` 含 channel.ts + polling/queue/router/media-store/typing/sender；channel 不反向依赖 engine（rg 为空）
  - [x] `src/engine/` 仅剩 wechat.ts；engine 不再直接持有协作类/状态逻辑，仅委托 Channel
  - [x] WechatEngine 公共 API/导出逐成员不变（WechatEngine/engine/createWechatEngine/setPi/setConfig/WechatHost/WechatConfig/ConnectionState，以及全部公共方法）
  - [x] 集成测试 tests/integration/channel-flow.test.ts 通过，覆盖入站/媒体/typing/出站/reset；真 Channel + 假 PiHost + 假端口 + 真实 storage（临时目录），未使用 mock.module 替换微信 vendor 边界
  - [x] vendor 目录零 diff
  - [x] 关键回归语义仍覆盖：D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9（engine.test.ts 全部保留）
  - [x] 提交原子、message 规范；未 push；未改 base（dev 为 HEAD 祖先）
design:
  - Channel 持有 ChannelState + PollingLoop + TurnQueue + SerialTaskQueue + MediaStore + TypingController +
    MessageSender + MessageRouter；未注入 ports 时在 Channel 内构造 createWechatInbound/Outbound/Media 默认 adapter
    （adapter 构造留在 Channel，供 S6 迁移到 index）。ChannelDeps 支持 state/host/config/notifier/ports/logger/sleep。
  - Channel 粗粒度 API：setHost/setNotifier/setConfig/configure、connectionState、getTerminalProcessing/setTerminalProcessing、
    initSession、startPolling/stopPolling、handleMessage、triggerAi、onAiDone、getTypingTicket、
    sendTypingStatus/startTyping/stopTyping、sendText/sendReply/sendFile、请求去重四方法、reset；
    私有 getCredentials/getCurrentOpts/generateRequestId/extractText/isSlashCommand/handleSlashCommand。
  - WechatEngine 退化为薄门面：`private channel = new Channel({ ports })`，公共成员逐一委托。
    createWechatEngine 兼容顶层 flat ports 与嵌套 `{ ports }` 两种写法（嵌套优先），并调用 configure 注入 host/config。
  - WechatHost 保持 `= PiHost` 别名；ConnectionState 从 ../channel/polling.js re-export；channel/router.ts 改用 PiHost。
regressions:
  - D3/D6/D7/D9/D13/D14/D15/D16(×3)/D16b/B4/B5(×2)/B6/C9 全在且通过；engine.test.ts 仅把 `(engine as any).state/queue/router/
    generateRequestId/isSlashCommand` 改走 `engine.channel.*`，断言不变。
notes: |
  - `bun test <单文件>` 不带 `--isolate` 会因 installBaseMocks 对 util/logger.js 的部分 mock 报
    `export 'setLogLevel' not found`（dev 基线同样如此）；项目标准命令 `bun run test` 即 `bun test --isolate`，全绿。
    新增集成测试按同一约定使用 installBaseMocks 固定 agentDir，未替换任何微信 vendor 模块。
  - 未新增依赖；package.json / bun.lock / tsconfig.json 零改动；工作树 clean。
  - docs/ARCHITECTURE.md 中仍提及 engine/* 路径（文档同步留给 S8），不在本阶段 scope。
