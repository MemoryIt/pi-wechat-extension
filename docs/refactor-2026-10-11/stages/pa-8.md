# Task: PA-8 文档与 C4 图同步（纯文档，不改代码/测试）

base: dev
branch: refactor/pa-8-docs-c4
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 127 pass / 15 files / 0 fail（文档阶段不得改代码/测试，测试数保持不变）
invariant: 不改任何 src/ 与 tests/ 代码；仅文档
commit: 原子提交；禁止 push；禁止改 base 分支

## goal
把文档更新为重构后的真实架构（Ports & Adapters / 薄通道）：更新 `docs/ARCHITECTURE.md`，
重画 C4 图（`engine`→`channel`，新增 `ports`/`adapters`），清理所有对已删除模块的引用。

## 当前真实结构（务必据此写）
```
src/index.ts        组合根：createExtension(deps?) 显式组装 PiHost + Channel + WechatAuth
src/bridge/         pi 侧适配：events / turn / meta / commands / tool-send-file / login（注入 Channel/WechatAuth）
src/channel/        通道核心：channel(粗粒度编排) / state(ChannelState) / polling / queue / router / media-store / typing / sender
src/ports/          端口接口：inbound / outbound / media / auth / pi-host / types
src/adapters/       微信侧薄包装：inbound / outbound / media / auth（唯一接触 vendor）
src/shared/         config / logger / time / paths / types / redact(边界) / file-logger(边界)
src/storage/        state / state-dir
vendor(顶层)        api/ auth/ cdn/ media/ messaging/ util/ —— 仅被 src/adapters/ 引用
```
- `src/engine/`、`WechatEngine`、`createWechatEngine`、模块级 `setPi`/`setConfig` 均已删除。
- 依赖方向：`index → bridge/channel/adapters/storage`；`bridge → channel`；`channel → ports/storage/shared`；`adapters → ports + vendor`；`ports → 无`；`channel` 不得 import `engine`（engine 已不存在）。
- 测试：`tests/unit`(L1) / `tests/channel`(L2 直接测 Channel + 纯类) / `tests/bridge`(L3 注入 fake channel/auth) / `tests/integration/channel-flow.test.ts`。

## scope
- 文档（修改）：
  - `docs/ARCHITECTURE.md`（重写/大幅更新：设计目标、分层与依赖方向、模块职责表、关键机制、adapter 调用面、数据布局、测试分层、扩展指引；移除 engine/WechatEngine/setPi/setConfig 相关描述）
  - `docs/c4/03-components.puml`（L3 组件图：index/bridge/channel/ports/adapters/storage/shared + 外部）
  - `docs/c4/03a-engine.puml` → **重命名** `docs/c4/03a-channel.puml`（channel 内部：Channel + state + 协作类 + 端口）
  - `docs/c4/04-class-engine.puml` → **重命名** `docs/c4/04-class-channel.puml`（Channel 子系统类图）
  - `docs/c4/_styles.puml`（如含 engine 文案则更新）
  - `README.md`（如含过时架构引用则更新；用户面向内容尽量不动）
- 文档（可选新增）：
  - `docs/c4/03b-ports-adapters.puml`：端口/适配器边界视图（channel → ports ← adapters → vendor）
- **不得改** `src/**`、`tests/**`。

## 要求
- C4 图遵循既有约定：`!include <C4/C4_Component>`、`_styles.puml` 的自定义 tag、`SHOW_LEGEND()`；文件命名沿用 `0X-*.puml`。
- 组件图保持单图 ≤ ~12 元素；channel 内部细节放 `03a-channel.puml`。
- 类图用 PlantUML 原生 class（非 C4 宏），覆盖 `Channel`、`ChannelState`、`PollingLoop`、`TurnQueue`、`SerialTaskQueue`、`MessageRouter`、`MediaStore`、`TypingController`、`MessageSender`、以及 ports 接口（`WechatInbound/Outbound/Media/Auth`、`PiHost`）。
- 文档与代码一致：以当前 `src/` 为准；不虚构。
- 不渲染图片（由人类在 VSCode 预览）。

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，测试数不变（127/15/0）
- [ ] `rg "src/engine|engine/wechat|WechatEngine|createWechatEngine" docs README.md` 为空
- [ ] 模块级 `setPi`/`setConfig` 在文档中不再作为公开 API 出现（可描述为已移除）
- [ ] `docs/c4/03a-engine.puml`、`docs/c4/04-class-engine.puml` 已重命名为 channel 版；引用同步
- [ ] `docs/ARCHITECTURE.md` 的模块表/依赖方向/测试分层与当前代码一致
- [ ] 所有 `.puml` 语法自洽（include/tag/宏名正确；不要求渲染）
- [ ] 未改动 `src/**`、`tests/**`
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 `src/**`、`tests/**`、vendor
- 不得改动运行时行为
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `docs(architecture): 更新为 Ports & Adapters 分层与模块职责`
2. `docs(c4): 重画 L3 组件图（channel/ports/adapters）`
3. `docs(c4): channel 子系统组件图与类图（engine→channel）`

## report
完成后写 `/tmp/pi-tasks/pa-8.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-8`
