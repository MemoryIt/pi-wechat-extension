status: done
branch: refactor/pa-8-docs-c4
commits:
- 1392a0f0cdca604732c11df2eb17b8048e0ebc7c docs(architecture): 更新为 Ports & Adapters 分层与模块职责
- 4de007ccd3c57059f605ca1340cda0a6357c5959 docs(c4): 重画 L3 组件图（channel/ports/adapters）
- f35316921012cfb445a478048037ab8332aba838 docs(c4): channel 子系统组件图与类图（engine→channel）
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（127 pass / 15 files / 0 fail / 364 expect calls）
test-changes: 新增 0，重命名 0，删除 0（纯文档阶段，未触碰 tests/**）。
scope-check: 未越界。改动清单（vs dev）：
  - docs/ARCHITECTURE.md（大幅重写：设计目标 / 分层与依赖方向 / 模块职责表 / 关键机制 /
    adapter 调用面 / 数据布局 / 测试分层 / 扩展指引；移除 engine 门面相关描述）
  - docs/c4/03-components.puml（重画：index / bridge / channel / ports / adapters / storage / shared + 外部）
  - docs/c4/03a-channel.puml（由 03a-engine.puml 重命名并重画为 Channel 子系统）
  - docs/c4/04-class-channel.puml（由 04-class-engine.puml 重命名并重画为 Channel 类图）
  - docs/c4/03b-ports-adapters.puml（新增：端口/适配器边界视图）
  - docs/c4/_styles.puml（更新 include 方注释）
  - 未改 src/**、tests/**（`git diff --name-only dev...HEAD -- src tests` 为空）
  - 未改 README.md（无过时架构引用，用户面向内容保持不动）
  - 未改 vendor；未改 package.json / bun.lock / tsconfig.json；未 push；未改 base（dev 为 HEAD 祖先）
acceptance:
  - [x] `bun run typecheck && bun run test` 全绿，测试数不变（127 pass / 15 files / 0 fail）
  - [x] `rg "src/engine|engine/wechat|WechatEngine|createWechatEngine" docs README.md` 为空
  - [x] 模块级 `setPi`/`setConfig` 仅以「已删除」形式出现，未作为公开 API 描述
        （ARCHITECTURE.md 开篇说明；04-class-channel.puml 的 `setConfig` 是 Channel 实例方法，非模块级）
  - [x] `docs/c4/03a-engine.puml`、`docs/c4/04-class-engine.puml` 已重命名为 channel 版，无残留引用
  - [x] `docs/ARCHITECTURE.md` 的模块表 / 依赖方向 / 测试分层与当前 src/ 一致
  - [x] 所有 `.puml` 语法自洽：C4 include / tag / 宏名正确，括号配平（未渲染，交由人类 VSCode 预览）
  - [x] 未改动 `src/**`、`tests/**`
  - [x] 提交原子、message 规范（3 个 commit，按建议拆分）
notes: |
  - 文档事实来源为实际 src/ 树，而非仅任务书摘要。与任务书「依赖方向」描述的两处差异按代码如实记录：
    * `src/channel/channel.ts` 当前仍 import `../adapters/*`，在未注入 ports 时缺省构造默认 adapters
      （源码注释标注为组合根职责、供后续 S6 迁移到 index）。文档在依赖图、模块表与约束 note 中显式标注为
      「过渡状态」，目标方向 `channel → ports` / `adapters → ports + vendor`。
    * `src/ports/types.ts` 会 re-export vendor 的 `api/types`，是 ports 层唯一的 vendor 协议类型边界；
      `src/shared/redact.ts` / `src/shared/file-logger.ts` 是 vendor 工具的两个再导出边界。文档第 5 节与
      ports/adapters 图均已列明，未虚构「ports → 无依赖」。
  - C4 约定沿用：`!include <C4/C4_Component>`、`_styles.puml` 自定义 tag（self / thirdparty / external；
    allowed / event）、`SHOW_LEGEND()`；文件命名 `0X-*.puml`。主组件图 11 个非边界元素（≤ ~12）。
  - 类图用 PlantUML 原生 class，覆盖 Channel、ChannelState、PollingLoop、TurnQueue、SerialTaskQueue、
    MessageRouter、MediaStore、TypingController、MessageSender，以及端口 WechatInbound/Outbound/Media/Auth、
    PiHost 与全部注入 deps（ChannelDeps/ChannelPorts/PollingLoopDeps/RouterDeps/TypingDeps/SenderDeps/
    MediaStoreOptions/SaveMediaFn/WechatCredentials/WechatApiOpts）。消息名中的 `{ path }` 已改为具名结果类型，
    避免 PlantUML 花括号歧义。
  - 未决项 / 需 human 决策：环境无 plantuml/java，无法渲染校验；仅做静态配平与宏/tag 一致性检查。
    建议人工在 VSCode PlantUML 预览 03-components / 03a-channel / 03b-ports-adapters / 04-class-channel。
  - 无新增依赖；未 push；未改 base 分支。
