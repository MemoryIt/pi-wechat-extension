status: done
branch: refactor/cs-doc-sync
commits:
- 6f6f611 docs(arch): 同步 channel 瘦身后的架构说明与 C4 图
- f5edc6b docs(tests): 同步 tests/README 的 D13/D15 与 CS 回归说明
- db33312 docs(refactor): 新增 2026-10-12b channel 瘦身档案与人工 E2E 清单

tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （194 pass / 24 files / 0 fail / 593 expect calls；与基线 194 / 24 / 0 完全一致，
   测试零改动；typecheck 零错误；install frozen-lockfile "no changes"）
  EXIT=0

docs-changes:
  A. docs/ARCHITECTURE.md（纯文档，+31/-? 行）
     - §1 纯协作类清单补 inbound-parser / inbound-handler / credential-loader。
     - §2 结构示意 `channel/*` 行补 create-channel（装配工厂）与四个新协作类；
       新增 bullet「TurnQueue 归属：MessageRouter 拥有 TurnQueue，Channel 不再直接持有」。
     - §3.3 channel 表：
       · channel.ts 改为「通道 facade：构造委托 createChannelRuntime(deps)」；
       · router.ts 改为「turn 编排唯一入口：拥有 TurnQueue，dispatch/onTurnDone/execute/drain」；
       · 新增 create-channel.ts / inbound-handler.ts / inbound-parser.ts / credential-loader.ts 四行；
       · request-id.ts 标注「现由 InboundHandler 持有」。
     - §4.1 新增入站路径 bullet：PollingLoop.onMessage → InboundHandler.handle() → MessageRouter.dispatch()。
     - §4.3 requestId 归属由「Channel 私有 generateRequestId()」改为「InboundHandler 持有
       RequestIdGenerator 并在 handle() 中调用 next()」；TurnQueue 标注由 MessageRouter 拥有。
     - §4.5 末条由 Channel.handleMessage() 改为 InboundHandler.handle()。
     - §4.8 补充「构造委托 createChannelRuntime(deps)」；ports 修正为必填 { inbound, outbound, media }。
     - §7.2 channel/ 文件清单补齐 create-channel / inbound-parser / inbound-handler / credential-loader。
     - §7.3 L2 被测对象补齐 typing / inbound-parser / inbound-handler / credential-loader。
     - 全文核对：不再出现 generateRequestId / isSlashCommand / extractText / handleSlashCommand。
  B. docs/c4/03a-channel.puml
     - 新增组件 inbound-parser / inbound-handler / credential-loader / create-channel；
       channelCore 描述改为 facade；queue 描述标注 TurnQueue 由 router 拥有。
     - 修正 requestId 关系：删除 `Rel(channelCore, requestId, "generateRequestId 委托")`，
       改为 `Rel(inboundHandler, requestId, "持有 / next()")`。
     - 补充 inbound-handler → state/typing/router、credential-loader → storage/state、
       router → parseInbound/queue、create-channel → 各组件装配 等关系；
       channelCore 不再直接持有 queue/mediaStore；storage/shared 关系改挂 credential-loader /
       inbound-handler / create-channel。
  C. docs/c4/04-class-channel.puml
     - Channel 字段改为实际保有：state / logger / credentialLoader / poller / typing / sender /
       router / inboundHandler；删除 sleep / mediaStore / mediaQueue / queue / requestId。
     - Channel 公共成员与代码事实一致（删除 getTerminalProcessing / getTypingTicket /
       sendTypingStatus / getCurrentRequestId / sendText，及全部私有方法）；构造函数标注
       「委托 createChannelRuntime 装配」。
     - 新增 InboundHandler（+ handle，持有 RequestIdGenerator）、CredentialLoader（+ ensureSession）、
       createChannelRuntime（工厂）、parseInbound（函数），及 InboundHandlerDeps /
       CredentialLoaderDeps / ChannelRuntime / ParsedInbound。
     - MessageRouter 增加 queue / dispatch / onTurnDone；RouterDeps 改为 queue? + isTerminalProcessing。
     - 组合/使用关系：MessageRouter *-- TurnQueue、InboundHandler *-- RequestIdGenerator、
       Channel 仅组合实际字段；InboundHandler ..> storage、MessageRouter ..> parseInbound；
       删除 Channel *-- RequestIdGenerator/TurnQueue/MediaStore/SerialTaskQueue。
     - 说明 note 全部同步；全图不再出现已删除方法/字段（非 Channel 类如 TurnQueue.getCurrentRequestId /
       MessageSender.sendText / WechatOutbound.getTypingTicket 属其自身成员，保留）。
  D. tests/README.md
     - D13 目标测试改为 `tests/channel/request-id.test.ts`（RequestIdGenerator 覆盖同毫秒唯一）。
     - D15 标注「已移除（CS-3：入站 slash 拦截整体删除；/ 开头消息现作为普通消息交给 LLM）」。
     - 新增「Channel 瘦身回归（CS-1–CS-7，2026-10-12b）」表；L2 分层被测对象补齐
       typing / inbound-parser / inbound-handler / credential-loader。
  E. 新增 docs/refactor-2026-10-12b/README.md
     - 基本信息（起始基线 dev@996e347 / v0.5.0、模型、171→194 测试基线）、目标（channel 瘦身）、
       cs-1~cs-7 + cs-doc 阶段总览表（分支/提交/测试/状态）、每阶段一句话结果、最终 src/channel/ 结构、
       测试数演进 171→176→189→184→188→194→194→194→194、流程约定（worktree + 实现/验证子 Agent + 归档）。
  F. 新增 docs/refactor-2026-10-12b/e2e-manual-2026-10-12b.md
     - 改编自上一轮 A–K 清单；明确标注「本轮为架构重构，未人工执行；行为由 194 个自动化用例覆盖」；
       新增「本轮行为变更（CS-3：/ 开头消息现进入 AI）」与「本轮重点回归（行为不变性）」两节。

scope-check: 未越界。`git diff dev...HEAD --stat` 仅 6 个文件：
  - docs/ARCHITECTURE.md（修改）
  - docs/c4/03a-channel.puml（修改）
  - docs/c4/04-class-channel.puml（修改）
  - docs/refactor-2026-10-12b/README.md（新增）
  - docs/refactor-2026-10-12b/e2e-manual-2026-10-12b.md（新增）
  - tests/README.md（修改）
  `git diff dev...HEAD -- src tests -- ':!tests/README.md' api auth cdn media messaging util types package.json bun.lock`
  为空；`git diff dev...HEAD -- docs/refactor-2026-10-11 docs/refactor-2026-10-12
  docs/refactor-2026-10-12b/stages` 为空（历史档案零改动）；
  `git status --short` 干净；未切换分支、未改 dev、未 push。

acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（EXIT=0，
        194 pass / 24 files / 0 fail，测试零改动；typecheck 零错误）
  - [x] `rg "generateRequestId|isSlashCommand|extractText|handleSlashCommand" docs/ARCHITECTURE.md docs/c4`
        无命中（exit 1）
  - [x] ARCHITECTURE §3.3 含 create-channel.ts / inbound-handler.ts / inbound-parser.ts /
        credential-loader.ts；§4.3 requestId 归属为 InboundHandler
  - [x] 04-class-channel.puml 的 Channel 不再列出已删方法/字段；含 InboundHandler / CredentialLoader /
        createChannelRuntime / parseInbound
  - [x] 03a-channel.puml requestId 关系改由 inbound-handler 持有
  - [x] tests/README.md D13 → request-id.test.ts；D15 标注已移除
  - [x] 新增 docs/refactor-2026-10-12b/README.md 与 e2e-manual-2026-10-12b.md
  - [x] `git diff dev...HEAD --stat` 仅限 docs/**、tests/README.md
  - [x] 代码/测试/vendor/lockfile 零 diff；历史档案零 diff
  - [x] 提交原子（3 个逻辑：arch 同步 / tests README / 本轮档案）、message 规范

notes: |
  - 纯文档阶段：src/**、tests/**（除 tests/README.md）、vendor、types、package.json、bun.lock
    全程零改动；测试数 194 pass / 24 files / 0 fail 与基线完全一致。
  - 拆为 3 个原子提交：①架构说明与 C4 图同步；②tests/README 同步；③新增本轮档案与人工 E2E 清单。
  - README.md 功能/限制章节未改动（cs-3 已更新）；未发现需修正项。
  - 阶段总览表中 cs-doc 提交记为「本阶段」（commit hash 在写入当时尚不存在），其余
    cs-1~cs-7 的 commit hash 均取自归档 result。
  - 04-class-channel.puml 中 `getCurrentRequestId` / `sendText` / `getTypingTicket` 的命中均属
    TurnQueue / MessageSender / WechatOutbound 自身成员，非 Channel；验收 rg 关键词（四个已删方法名）
    在 docs/c4 全图零命中。
  - 未决项 / 需 human 决策：无。
