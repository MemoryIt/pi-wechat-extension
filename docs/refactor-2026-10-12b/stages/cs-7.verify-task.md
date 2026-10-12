# Verify: CS-7 收敛 Channel facade 公共面

base-branch: refactor/cs-7-facade-narrowing
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/channel.ts`、`tests/channel/**`、`tests/integration/**`）
- [ ] 逐条核对 `cs-7.md` 的 acceptance 与「行为契约」
- [ ] `rg "getTerminalProcessing|getTypingTicket|sendTypingStatus|getCurrentRequestId|sendText" src/channel/channel.ts` 无命中
- [ ] 5 个被删方法在 `src/` 中确无生产调用（`rg` 复核：`channel.ts` 外无 `.getTypingTicket/.sendTypingStatus/.getCurrentRequestId/.getTerminalProcessing/` 对 Channel 实例的调用）
- [ ] 新增 `tests/channel/typing.test.ts` 直接测 `TypingController`，逐条覆盖原 D16：
      contextToken 变化重新取票 / TTL 60s 命中与过期重取 / `sendStatus` 报错含 ticket 清缓存
- [ ] `tests/channel/channel.test.ts`：D16 三例已迁移删除、D16b 保留；其余用例未削弱
- [ ] `tests/integration/channel-flow.test.ts`：requestId 观察语义等价（相等 / 当前非空 / onAiDone 后 null）
- [ ] **审计 tests/** 的 diff**：D16 三例去向=迁移；集成测试修改为等价观察；抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：被删方法与测试引用一一对应，无遗留引用；`TypingController` 新用例覆盖迁移语义
- [ ] `tests/setup/bridge-harness.ts` 的 fake 未被删除；`handleMessage/triggerAi/setTerminalProcessing/`
      `startTyping/stopTyping/isRequestProcessed/markRequestProcessed` 仍在
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-7.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-7-verify`
