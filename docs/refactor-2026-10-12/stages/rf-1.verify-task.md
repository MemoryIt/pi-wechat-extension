# Verify: RF-1
base-branch: refactor/rf-1-application-reply
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（129 pass / 15 files / 0 fail），与 `rf-1.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/application/*`、`src/bridge/events.ts`、
      `src/index.ts`、`tests/application/reply.test.ts`）
- [ ] 逐条核对 `rf-1.md` 的 acceptance 与「行为契约」
- [ ] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
- [ ] `src/bridge/events.ts` 不再出现 `sendReply` / `markRequestProcessed` / `isRequestProcessed` 决策
- [ ] D1/D2/D5 语义仍被覆盖：`tests/bridge/event-wiring.test.ts` 与 `tests/application/reply.test.ts`
- [ ] vendor 目录 diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-1.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-1-verify`
