status: done
branch: refactor/rf-3-instance-state
commits:
- 8376633dc3f3f0b78aed3ab7ec46e589a21e92ce refactor(bridge): 去模块级可变状态并改为组合根实例注入
- 31822a20baebb4e1d35d11a3a2b1ec2ed0915dd2 test(bridge): 新增实例状态隔离用例
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（158 pass / 18 files / 0 fail / 454 expect calls；基线 155 / 17 / 0，新增 3 例）
test-changes: 新增 3，修改 7（同一批既有用例），删除 0
  - 新增 tests/bridge/state-isolation.test.ts（3 例）：
    TurnResolver 实例间 FIFO 隔离（向 A push，B 不命中；A 命中即出队，再查同一 prompt 不再命中）；
    MetaBuilder 实例间成本累计隔离（A 累计 0.5，B 空分支为 0）；
    MetaBuilder git 分支缓存实例隔离（A refresh 后为 feature-branch，B 仍 null）。
  - 修改 tests/bridge/turn.test.ts：FIFO 相关两例改用 `new TurnResolver()`；
    移除 `beforeEach(resetPendingWechatInputs)`（实例天然隔离）。
  - 修改 tests/bridge/meta.test.ts：两例改用 `new MetaBuilder()`；成本累计用例在**同一实例**上先
    accumulateCost 再 buildMetaInfo，保持「旧 entry 不重复读取 + 增量累计 $0.300」断言不变。
  - 既有测试断言未被削弱：turn-state.test.ts（D4/D21）与 event-wiring.test.ts（D11/D20/D2/D5 等）零改动，全绿。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 8 个文件：
  - src/bridge/turn.ts（新增 TurnResolver 实例类，FIFO 状态入实例；纯函数导出不变）
  - src/bridge/meta.ts（新增 MetaBuilder 实例类，cachedGitBranch/costAccumulator 入实例；readGitBranch 仍为模块函数）
  - src/bridge/events.ts（删除模块级 logger，registerBridge(pi, BridgeDeps) 构造注入）
  - src/bridge/tool-send-file.ts（createSendFileTool(channel, logger)，删除模块级 logger）
  - src/index.ts（(pi)=>{} 内 new TurnResolver()/new MetaBuilder()，同一 logger 注入 tool 与 bridge）
  - tests/bridge/{turn,meta}.test.ts（适配实例化）＋ tests/bridge/state-isolation.test.ts（新增）
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
    src/shared/config.ts、src/storage/state.ts、src/channel/**、src/ports/**、src/adapters/**、src/application/** 零 diff；
    dev 为 HEAD 祖先（3fd67c3），未 push
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，158 pass / 18 files ≥ 155 / 17；typecheck 零错误
  - [x] `rg "^let |^const .* = new (Map|Set)|^const .*: .*\[\] =" src/bridge src/application` 无命中（exit 1）
  - [x] `rg "^const logger = createLogger" src/` 无命中（exit 1）
  - [x] `TurnResolver` / `MetaBuilder` 为实例类；turn.ts 仍导出 getBranch/isAssistantMessage/extractLastReply/
        extractReplyText/resolvePendingWechatMeta/resolveActiveWechatMeta/resolveTurnFromBranch，meta.ts 仍导出 readGitBranch
  - [x] 新增 tests/bridge/state-isolation.test.ts 且通过
  - [x] 既有 D4/D21（tests/bridge/turn-state.test.ts）与 event-wiring.test.ts 通过，断言零改动未被削弱
  - [x] `git diff dev...HEAD --stat` 仅限 src/bridge/{turn,meta,events,tool-send-file}.ts、src/index.ts、tests/bridge/*
  - [x] 提交原子（refactor 实现 → test 新增，两个 commit 均可编译 / 测试通过），message 规范
behavior-contract:
  - [x] input：`source === "extension"` 且 `deps.turn.resolveTurnBeforeRun(ctx).fromWechat` 时
        `deps.turn.pushPendingWechatInput({ requestId, text })`；非 extension 立即 continue。
  - [x] before_agent_start：`deps.turn.resolveTurnBeforeRun(ctx, event.prompt)`；微信 turn 仅 debug 日志；
        非微信 turn `channel.setTerminalProcessing(true)` + debug 日志（文案逐字不变）。
  - [x] agent_settled：`resolveTurnFromBranch(ctx)`；非微信走 fromWechat=false DTO（metaText=null，不扫描分支）；
        微信且有 replyText 时 `meta.buildMetaInfo(ctx)`，DTO 字段与调用参数不变。
  - [x] session_start：`await meta.refreshGitBranch(pi)`；setNotifier → session.startFromStoredToken(createSessionUi(ctx)) 不变。
  - [x] pendingWechatInputs 消费语义不变（findIndex + splice 命中即出队，只消费首个匹配）。
  - [x] costAccumulator 增量语义不变（按 entry id 去重；分支连续增长只处理新增；压缩/分叉回退全量去重扫描；
        anchor=lastIndex-1 且 id 一致才沿用 start）；D21 用例断言 `$0.300` 与「旧 entry 只读一次」保持不变。
  - [x] 同一次 `createExtension()(pi)` 内多次事件共享同一 TurnResolver/MetaBuilder/logger；不同 createExtension()
        调用与测试实例互不污染（state-isolation 用例证明 D4/D21 语义不回退）。
notes: |
  - 状态注入：`BridgeDeps = { channel, reply, session, turn, meta, logger }`；events.ts 内解构
    `{ channel, reply, session, meta, logger }`，turn 经 `deps.turn` 显式引用以避免与局部 `const turn = ...` 冲突。
  - turn.ts 仅保留纯函数模块导出并新增 TurnResolver；meta.ts 新增 MetaBuilder，`readGitBranch(pi)` 保持模块函数。
    `refreshCachedGitBranch` 更名为实例方法 `refreshGitBranch`（唯一调用点在 events.ts，已同步）。
  - 依赖方向未变：src/bridge/** 仍只 import channel/application 类型/ports/storage/shared；新增 import 仅为
    `../shared/logger.js`（类型 PluginLogger）与 `./turn.js`；application 未回退依赖 bridge。
  - 明确不改（out of scope）：src/shared/config.ts 的模块级 cachedConfig（含 clearConfigCache()）与
    src/storage/state.ts 的 mutationQueues（按路径串行化的并发原语）保持原样，本轮零 diff。
  - 过程记录：首次两个 commit 命令并行执行触发 git index.lock 竞争，软重置到 dev 后按顺序重做，
    最终历史为 refactor → test。
  - 未决项 / 需 human 决策：无。
