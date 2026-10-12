# 重构档案：应用层边界与状态收敛（2026-10-12）

本目录记录 **pi-wechat-extension** 在 2026-10-12 起的第二轮重构：在「轻量 Ports & Adapters 薄通道」
（见 `docs/refactor-2026-10-11/`）基础上，补齐缺失的 **application 用例层**、收敛会话生命周期、
清除自写层模块级可变状态，并把 adapters 明确为 Anti-Corruption Layer。

> 目录与文件约定：`docs/refactor-<date>/`（README + e2e-manual）+ `stages/` 每阶段四件套。
> 命名采用**方案 B（点号 + 角色后缀）**，取代上一轮易混的 `-verify` / `.verify` 差异：
>
> | 角色 | 文件名 |
> |---|---|
> | 任务书 | `<s>.md` |
> | 验证指令（给 verifier） | `<s>.verify-task.md` |
> | 实现结果 | `<s>.result.md` |
> | 验证报告 | `<s>.verify-result.md` |
>
> 运行时交接目录为 `/tmp/pi-tasks/`，完成信号用 `tmux wait-for -S task-<s>` / `task-<s>-verify`。

## 基本信息

| 项 | 值 |
|---|---|
| 起始基线 | `dev` @ `27febd7`（v0.4.0） |
| 模型 | `opencode-go/deepseek-v4-flash`（注意：`deepseek-flash` 会 403） |
| 自动测试基线 | **129 pass / 15 files / 0 fail**；`bun run typecheck` 零错误 |
| 验收基线（S8） | **171 pass / 20 files / 0 fail**；`bun install --frozen-lockfile` + `typecheck` + `test` 全绿 |
| 运行时 | Node ≥ 22.19；开发/测试用 Bun |
| vendor | `api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts` **冻结，零改动** |
| 所有权 | 仅重构 `src/` |

## 目标

1. 引入 `src/application/`：承载用例（session / reply / commands），让 `bridge` 只做事件翻译。
2. 会话生命周期单一入口，消除 `setConfig` 与 `startPolling(opts)` 双凭证来源（A3 类问题）。
3. 清除 `src/` 模块级可变状态（turn FIFO / meta 缓存 / 模块级 logger）。
4. `adapters/` 明确为 ACL，vendor 怪异集中说明；端口签名冻结。
5. 保持对外行为与测试全绿。

## 阶段总览

| 阶段 | 内容 | 依赖 | 风险 | 状态 |
|---|---|---|---|---|
| S0 | 基线冻结（主 Agent，不派子 Agent） | — | — | ✅ 基线 129 pass |
| **S1** | 抽出 `application/reply`，`bridge/events` 变薄 | S0 | 中 | ✅ 完成 `a289c2f`（138 pass） |
| **S2** | 会话生命周期收拢到 `application/session` | S1 | 中 | ✅ 完成 `aa55943`（155 pass） |
| S3 | 去模块级可变状态 + `index` 闭包接线 | S2 | 低–中 | ✅ 完成 `31822a2`（158 pass） |
| S4 | 修 A3：`polling.start()` 同步 `connecting` | 可与主线并行 | 低 | ✅ 完成 `2f49ced`（160 pass） |
| S5 | adapters ACL + vendor 耦合文档 + 端口冻结 | 可与主线并行 | 低 | ✅ 完成 `643596e`（163 pass） |
| S6 | Channel 瘦身 / ChannelState 收敛（可选） | S1–S3 | 中 | ✅ 完成 `093cf86`（167 pass） |
| S7 | F6「连发多图后文本阻塞」定位与修复 | 独立 | 中 | ✅ 完成 `1f535de`（171 pass） |
| S8 | 文档归档与清理（ARCHITECTURE/C4 同步 + E2E 清单 + README 收尾） | 全部 | 低 | ✅ 完成 `63589b3`（171 pass；首轮 FAIL → `f32bb20` 修正 → 最终 PASS） |

## 最终架构

```
src/index.ts  组合根：createExtension() 显式组装 application + ChannelState + adapters + Channel + PiHost + Auth
  ├─ application/   用例层：reply（ReplyService：agent_settled 发送决策）/ session（SessionService：会话生命周期）
  │                  types（DTO + 窄接口 ReplyChannel/SessionChannel）；不依赖 pi / vendor / 具体 Channel
  ├─ bridge/        pi 适配层（事件翻译）：events / turn / meta / commands / session-ui / tool-send-file
  ├─ channel/       通道核心：Channel + state + request-id（RequestIdGenerator）+ polling/queue/router/
  │                  media-store/typing/sender（只依赖 ports / storage / shared）
  ├─ ports/         端口接口：inbound / outbound / media / auth / pi-host / types
  ├─ adapters/      微信侧薄包装（ACL）：唯一接触 vendor 的模块
  ├─ storage/       持久化（atomic write + per-path 串行队列）
  └─ shared/        基础 + redact/file-logger 再导出边界
```

依赖方向（单向，无倒置）：`index → bridge / application / adapters / channel / ports`；
`bridge → application（事件→用例委托）/ channel（BridgeChannel 窄接口）/ shared`；
`application → channel（ReplyChannel/SessionChannel）/ ports（WechatAuth）/ storage / shared`；
`channel → ports / storage / shared`；`adapters → ports + vendor`。

## 结果汇总

- **测试**：129 → **171 pass / 20 files / 0 fail**；`bun run typecheck` 零错误；vendor **零改动**。
- **新增 `src/application/`**：`reply.ts`（`ReplyService` + `SettledContext`/`ReplyChannel`）、
  `session.ts`（`SessionService` + `SessionUi`/`SessionChannel`）、`types.ts`；`bridge` 退化为事件翻译。
- **新增 `src/channel/request-id.ts`**：`RequestIdGenerator`（`YYMMDDHHMMSSmmm` + 3 位序号），
  `ChannelState` 收敛（去掉 requestId 追踪）；`Channel` 删除 `configure()`/`cleanupProcessedRequests()`。
- **ACL 明确**：`docs/vendor-constraints.md`（S5）记录 vendor 不可动耦合、端口冻结与责任边界。
- **A3 修复**：`PollingLoop.start()` 同步 `connecting`，重启后 `/wechat status` 状态及时更新。
- **F6 修复**：单条 `onMessage` 失败隔离 + 媒体 ack 失败仅记录日志，连发多图后文本不再阻塞。
- **归档**：ARCHITECTURE/C4 同步（`d666130`）；人工 E2E 清单 `e2e-manual-2026-10-12.md`（`8d194be`）；
  各阶段四件套见 `stages/`（rf-1 ~ rf-8）。

## 流程约定

- 每个阶段从 `dev` 切分支 `refactor/<s>-<slug>`，子 Agent 只在自己的 worktree 工作。
- 子 Agent：实现 → typecheck/test → 原子提交到本分支 → 写 `/tmp/pi-tasks/<s>.result.md` →
  `tmux wait-for -S task-<s>`。
- 验证 Agent：只读复验本分支 → 写 `/tmp/pi-tasks/<s>.verify-result.md` → `tmux wait-for -S task-<s>-verify`。
- 每阶段结束后，把 `/tmp/pi-tasks/<s>.result.md` / `<s>.verify-result.md` 归档到 `stages/` 下对应文件名。
- **禁止任何子 Agent push**；push 只能由主 Agent 在人类明确指令后执行。
- 验证 PASS 且人工确认后，主 Agent 才 `git merge --ff-only` 合回 `dev`。

## 已知约束（vendor）

详见 `docs/vendor-constraints.md`（S5 产出）。当前已确认：vendor `messaging/inbound.ts` 反向 import
`../src/storage/state-dir.js`（类型导入，运行时不加载）；vendor 内部直接使用 `util/logger.ts`
（写 `$TMPDIR/openclaw-*.log`）；`getUpdates` 不接受 AbortSignal（35s 双常量）。
