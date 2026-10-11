status: done
branch: refactor/pa-7-remove-engine
commits:
- 69f0b9fb1a695ba25490e1091c118d1aece67b50 test(channel): 将 engine 测试迁移到 tests/channel 并直接测 Channel
- 03a983553e79944f9233e3f28e546aa6ea6cba73 refactor(channel): 删除 WechatEngine 门面与 src/engine/
- 7f8be3a96cbeeddcda07859cb76a29b2e01c0e10 chore(test): 更新 tests/README 路径
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（127 pass / 15 files / 0 fail / 364 expect calls）
test-changes: 基线 127 pass / 15 files → 127 pass / 15 files（净 0；新增 0，重命名 5，删除 0）。明细：
  - 重命名 tests/engine/engine.test.ts → tests/channel/channel.test.ts：改为 `new Channel({host,config,ports})`
    直接测通道（不再经 WechatEngine 门面）；方法名机械映射 initSingleUser→initSession、
    startTypingKeepalive→startTyping、stopTypingKeepalive→stopTyping、sendMessageWithRetry→sendReply、
    sendFileToUser→sendFile、`(engine as any).channel.*`→`(channel as any).*`；断言语义不变，21 个用例全保留。
  - 重命名 tests/engine/media-store.test.ts → tests/channel/media-store.test.ts（仅头注释路径）。
  - 重命名 tests/engine/queue.test.ts → tests/channel/queue.test.ts（仅头注释路径）。
  - 重命名 tests/engine/router.test.ts → tests/channel/router.test.ts（仅头注释路径）。
  - 重命名 tests/setup/engine-harness.ts → tests/setup/channel-harness.ts：importEngine→importChannel、
    installEngineMocks→installChannelMocks、EnginePi/createEnginePi→ChannelPi/createChannelPi；
    端口 fake / fixture / seed 不变。
  - 修改 tests/unit/dependencies.test.ts：CORE_FILES 的 `src/engine/wechat.ts` → `src/channel/channel.ts`。
  - 修改 tests/README.md：`tests/engine`、`src/engine/wechat.ts` 等旧路径改为 `tests/channel`、`src/channel/*`，
    同步 L2 分层与 --isolate 说明。
scope-check: 未越界。改动清单（vs dev）：
  - 删除 src/engine/wechat.ts（含空目录 src/engine/）
  - 修改 src/channel/{channel,router,state}.ts、src/ports/pi-host.ts（仅注释，清理 WechatEngine/WechatHost 提法）
  - 新增 tests/channel/{channel,media-store,queue,router}.test.ts
  - 新增 tests/setup/channel-harness.ts；删除 tests/setup/engine-harness.ts 与 tests/engine/*
  - 修改 tests/unit/dependencies.test.ts、tests/README.md
  - 未改 vendor（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - 未改 package.json / bun.lock / tsconfig.json；未 push；未改 base（dev 为 HEAD 祖先）
acceptance:
  - [x] `bun run typecheck && bun run test` 全绿，127 ≥ 基线 127
  - [x] `test -d src/engine` 为假；`rg "src/engine|engine/wechat" src tests` 为空
  - [x] `rg "\bWechatEngine\b|createWechatEngine" src tests` 为空（注释已清理）
  - [x] tests/channel/ 含 channel/media-store/queue/router 测试；tests/setup/channel-harness.ts 存在，
        tests/setup/engine-harness.ts 不存在
  - [x] tests/unit/dependencies.test.ts 的 CORE_FILES 指向 src/channel/channel.ts 且通过
  - [x] 回归用例全在且通过：D3(1)、D6(1)、D7(1)、D9(2)、D13(1)、D14(1)、D15(2)、D16(3)、D16b(1)、
        B4(1)、B5(2)、B6(1)、C9(1)（C9 改为「两个 Channel 实例互不污染」）
  - [x] vendor 目录零 diff
  - [x] 提交原子、message 规范
notes: |
  - 任务书建议的提交顺序为「先删 prod 门面 → 再迁移测试 → 最后 chore」。但先删 src/engine/wechat.ts 会让
    tests/engine/engine.test.ts 与 tests/setup/engine-harness.ts 立即导入失败，单个 commit 无法全绿。
    为使每个提交原子且 HEAD 全绿，调整为「先迁移测试（此时 prod 门面仍在，测试已不依赖它）→ 再删 prod 门面
    → 最后 README」。三个提交各自 `bun run typecheck && bun run test` 均通过。
  - 运行时字符串 `"WechatHost not configured"`（src/channel/router.ts 两处）按任务书保留原样：无测试断言它，
    改动会引入行为变化风险；仅清理了注释中的 WechatEngine/WechatHost 提法。
  - 无新增依赖；未触碰 vendor / 组合根 index.ts / bridge。
