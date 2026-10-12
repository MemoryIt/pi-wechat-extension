# Verify: CS-1 turn 编排单一化

base-branch: refactor/cs-1-turn-orchestration
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{channel,router}.ts`、`tests/channel/**`、`tests/integration/**`）
- [ ] 逐条核对 `cs-1.md` 的 acceptance 与「行为契约」
- [ ] **编排唯一入口**：`src/channel/channel.ts` 不再声明 `TurnQueue` 字段；
      `triggerAi`/`onAiDone` 委托 router；队列状态迁移（busy/currentRequestId/drain）只在 router 改写
      （用 `rg` 确认 Channel 内无 `setBusy|setCurrentRequestId|\.drain\(`）
- [ ] `MessageRouter` 提供 `dispatch` / `onTurnDone`，语义分别等价原 `Channel.triggerAi` / `Channel.onAiDone`
- [ ] 文本路径：`appendEntry(wechat_meta)` + `sendUserMessage`；成功后保持 busy（D1）
- [ ] 错误路径：不冒泡、释放忙闲、`markRequestProcessed`、必要时排空
- [ ] 媒体路径：ack 失败隔离（F6 日志 "Media ack failed"）、入后台队列、mark、不占忙闲
- [ ] `Channel` 公共方法与四个窄接口（BridgeChannel/SendFileChannel/ReplyChannel/SessionChannel）契约不变
- [ ] **审计 tests/** 的 diff**：每个删除/修改用例都能按 ledger 对应到「迁移 / 被蕴含 / 失效」；
      抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：被改的公共方法/类，其测试去向已覆盖
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-1.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-1-verify`
