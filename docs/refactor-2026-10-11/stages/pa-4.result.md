status: done
branch: refactor/pa-4-channel-state
commits:
- af2e9d6f98904eb2e1fbaa5f8094d95840d11b56 refactor(channel): 新增 ChannelState 承载运行时会话状态
- 99b64eb5b6b0895046dc820a0eb7c2805849526d refactor(engine): 字段迁移到 ChannelState（公共 API 不变）
- 8b20992a8d8e3fd5df6be431f1365ea6883b609d fix(sender): 恢复 sendWithRetry 缺凭证前置检查
- ec14f4120e05cbf73a60ef31e83a9c5af094f5b3 test: ChannelState 与 sendWithRetry 前置检查
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（121 pass / 14 files / 0 fail / 330 expect calls）
test-changes: 基线 115 → 121（净 +6；文件数 13 → 14）。明细：
  - tests/unit/channel-state.test.ts 0 → 4（新增：默认值、字段读写、resetSession 清凭证/终端/计数且保留 config/host/notifier、重复 resetSession 幂等）
  - tests/engine/engine.test.ts 19 → 21（+2：sendWithRetry 缺凭证立即抛 "Single user not initialized" 且 outbound.sendText 未被调用/不重试不 sleep；凭证就绪时正常一次发送）
  - 既有 12 个测试文件用例数不变，无删除、无重命名；断言语义保持
scope-check: 未越界。改动清单（vs dev）：
  - 新增 src/channel/state.ts（ChannelState + Notifier）
  - 修改 src/engine/wechat.ts（字段改由 private state: ChannelState 承载；WechatHost = PiHost 别名；公共 API 不变）
  - 修改 src/engine/sender.ts（SenderDeps 增加 canSend(): boolean；sendWithRetry 入口前置检查）
  - 修改 tests/engine/engine.test.ts（私有字段访问改走 state；新增 sendWithRetry 前置检查用例）
  - 新增 tests/unit/channel-state.test.ts
  - vendor 目录（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - src/bridge/{events,commands,tool-send-file}.ts diff vs dev 为空
acceptance:
  - [x] typecheck + test 全绿，121 ≥ 115 + 新增 6，既有语义与计数不降
  - [x] 新增 src/channel/state.ts；`rg "from \"\.\./engine" src/channel` 为空（无 channel → engine 反向依赖）
  - [x] WechatEngine 公共 API 逐成员不变（方法名/签名/返回与 dev 一致；仅内部字段改走 state）
  - [x] resetSession() 语义与旧 reset() 一致：清凭证（accountId/userId/contextToken）+ 终端标志 + 请求计数；保留 config/host/notifier（单测覆盖）
  - [x] sendWithRetry 缺凭证立即抛 "Single user not initialized"，outbound.sendText 未被调用（engine.test.ts 覆盖）
  - [x] vendor 目录零 diff
  - [x] src/bridge/{events,commands,tool-send-file}.ts 行为未改（零 diff）
  - [x] 提交原子（4 个逻辑提交，一一对应建议拆分），未 push，未改 base 分支（dev 为 HEAD 祖先）
design:
  - ChannelState 只承载运行时会话状态：accountId/userId/contextToken、config(WechatApiOpts)、host(PiHost)、
    notifier(Notifier)、isTerminalMessageProcessing、lastRequestIdMs/requestIdSeq；只 import ../shared/types 与
    ../ports/pi-host，避免 channel → engine 反向依赖。
  - 协作类保持独立：PollingLoop / TurnQueue / SerialTaskQueue / TypingController / MessageSender /
    MessageRouter / MediaStore 均未并入 ChannelState；syncCursor 仍留在 PollingLoop 内部。
  - WechatEngine 用 `private state = new ChannelState()` 替代原字段，所有读写改走 state.*；
    setHost/setNotifier/setConfig/configure/getTerminalProcessing/setTerminalProcessing/initSingleUser/
    handleMessage/getCredentials/getCurrentOpts/reset/generateRequestId 行为不变。
  - WechatHost 改为 `export type WechatHost = PiHost`，router.ts 等既有 import 不变。
  - sendWithRetry 入口恢复前置检查：engine 注入 `canSend: () => this.getCredentials() !== null`；
    缺凭证立即抛错、不重试、不 sleep、不调用 outbound.sendText（与 dev 旧行为一致）。
regressions:
  - D3/D6/D7/D9/D13/D14/D15/D16(×3)/D16b/B4/B5(×2)/B6/C9 全在且通过，未删除/弱化。
  - PA-3 verifier 记录的 sendWithRetry 缺凭证重试差异已修复并有测试覆盖。
notes: |
  - 由于私有字段迁移，tests/engine/engine.test.ts 中两处对私有字段的直接访问改为经
    `(engine as AnyEngine).state.*`（beforeEach 终端标志、D16 改 contextToken），仅测试观测点变化，
    断言语义不变。
  - sendWithRetry 测试用「outbound.sendText 零调用 + 立即返回耗时 < 900ms」共同证明未进入重试/
    未 sleep；凭证就绪用例验证正常一次发送。
  - 未新增依赖；package.json / bun.lock / tsconfig.json 零改动；未 push；工作树 clean。
