status: done
branch: refactor/rf-1-application-reply
commits:
- 310b481f715fdb28437170f124a6d6ccb364e7e5 feat(application): 新增 ReplyService 承载 agent_settled 发送决策
- a289c2fc547373fb9948e01460185a7214393843 refactor(bridge): agent_settled 委托 ReplyService，events 变薄
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（138 pass / 16 files / 0 fail / 399 expect calls；基线 129 / 15 / 0）
test-changes: 新增 9，重命名 0，删除 0
  - 新增 tests/application/reply.test.ts（9 例，fake ReplyChannel，不经过 pi）：
    fromWechat=false；成功顺序 stopTyping→sendReply→markRequestProcessed→onAiDone；
    metaText 拼接 / 空 meta 不追加空行；sendReply 抛 Error / 抛非 Error（notify 文案）；
    requestId=null；已处理；无 replyText
  - 既有 tests/bridge/event-wiring.test.ts（D1/D2/D5）等断言零改动
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 5 个文件：
  - src/application/types.ts（新增，SettledContext + ReplyChannel）
  - src/application/reply.ts（新增，ReplyService.handleSettled）
  - src/bridge/events.ts（registerBridge 增加 reply 参数；agent_settled 只做 事件→DTO；删除 handleWechatSettled）
  - src/index.ts（组合根 new ReplyService({ channel, logger }) 注入 registerBridge）
  - tests/application/reply.test.ts（新增）
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
    src/bridge/turn.ts、meta.ts、channel/**、ports/**、adapters/** 零 diff；dev 为 HEAD 祖先；未 push
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，138 pass / 16 files ≥ 129 / 15
  - [x] 新增 src/application/types.ts、src/application/reply.ts、tests/application/reply.test.ts
  - [x] `rg "sendReply|markRequestProcessed|isRequestProcessed" src/bridge/events.ts` 无命中（决策已迁出）
  - [x] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
  - [x] D1/D2/D5 既有测试（tests/bridge/event-wiring.test.ts）仍全绿；新增 reply.test.ts 逐条覆盖行为契约
  - [x] `git diff dev...HEAD --stat` 仅限上述 5 个文件
  - [x] 提交原子、message 规范（feat/refactor 两个逻辑 commit）
behavior-contract:
  - [x] fromWechat=false → setTerminalProcessing(false) 随后 onAiDone()，不发送（DTO 提取 replyText/metaText 均为 null，
        未调用 extractLastReply/buildMetaInfo）
  - [x] fromWechat=true 且 requestId 空 / 已处理 / 无 replyText → 不发送，最终 onAiDone()
  - [x] 成功：stopTyping() → sendReply(finalReply) → 成功后 markRequestProcessed(requestId)
  - [x] finalReply = replyText + (metaText ? "\n\n" + metaText : "")，由 ReplyService 统一拼接
  - [x] 发送失败：不 markRequestProcessed；notify("微信回复失败: <msg>", "error")
  - [x] handleSettled 所有路径 finally onAiDone()
notes: |
  - 提交按「应用层实现 + 测试」与「bridge/index 接线」拆为两个原子 commit；为避免第一 commit 留下死代码，
    顺序为 application 先行（此时纯新增，不改变运行时行为，测试已含新用例全绿），再接线。每个 commit 均可编译 / 测试通过。
  - 依赖方向：src/application/reply.ts 仅 import ./types.js 与 ../shared/logger.js；types.ts 零 import。
  - 行为不变性：终端 turn 的 setTerminalProcessing→onAiDone 顺序、微信 turn 的 stopTyping→send→mark 顺序、
    D2 失败不 mark、D1 finally 释放队列、D5 terminal 标志兜底均与迁移前逐字等价；公共 API、持久化格式、redact 规则未改。
  - 唯一内部差异：迁移前 buildMetaInfo 在 await stopTyping() 之后同步调用；现在由 bridge 在构造 DTO 时先算好
    （仅当 replyText 存在时），metaText 为纯同步派生值且 accumulateCost 按 entry id 去重，无外部可观测差异；
    既有 tests/bridge/meta.test.ts 与全量回归均绿。
  - 未决项 / 需 human 决策：无。
