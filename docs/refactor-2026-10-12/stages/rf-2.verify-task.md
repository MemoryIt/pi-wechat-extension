# Verify: RF-2
base-branch: refactor/rf-2-session
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（138 pass / 16 files / 0 fail），与 `rf-2.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/application/session.ts`、`src/bridge/session-ui.ts`、
      `src/bridge/commands.ts`、`src/bridge/events.ts`、`src/index.ts`、删除 `src/bridge/login.ts`、
      新增 `tests/application/session.test.ts`）
- [ ] 逐条核对 `rf-2.md` 的 acceptance 与「行为契约」（逐条对照用户可见文案是否逐字一致）
- [ ] `rg "startPolling|setConfig" src/bridge` 无命中；`rg "startPolling" src/application` 仅 session.ts 唯一调用点
- [ ] `rg "getDefaultAccountToken|deleteAccountData|removeAccount|saveToken|upsertAccount" src/bridge` 无命中
- [ ] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
- [ ] `rg "qrcode-terminal" src/application` 无命中（只应在 `src/bridge/session-ui.ts`）
- [ ] `src/bridge/login.ts` 已删除；D11/D20 等既有测试仍通过且断言未被削弱
- [ ] vendor 目录 diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-2.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-2-verify`
