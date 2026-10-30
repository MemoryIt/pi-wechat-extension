# Verify: RF-3
base-branch: refactor/rf-3-instance-state
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（155 pass / 17 files / 0 fail），与 `rf-3.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/bridge/{turn,meta,events,tool-send-file}.ts`、
      `src/index.ts`、`tests/bridge/*`）
- [ ] 逐条核对 `rf-3.md` 的 acceptance 与「行为契约」
- [ ] `rg "^let |^const .* = new (Map|Set)|^const .*: .*\[\] =" src/bridge src/application` 无命中
- [ ] `rg "^const logger = createLogger" src/` 无命中
- [ ] `TurnResolver` / `MetaBuilder` 为实例类；`turn.ts` 的纯函数仍被导出且语义未变
- [ ] 实例隔离测试存在且通过（两个 resolver / 两个 builder 互不共享）
- [ ] 既有 D4/D21 与 `event-wiring.test.ts` 全绿且断言未削弱
- [ ] `src/shared/config.ts`、`src/storage/state.ts`、`src/channel/**`、`src/ports/**`、
      `src/adapters/**`、`src/application/**` diff 为空
- [ ] vendor diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-3.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-3-verify`
