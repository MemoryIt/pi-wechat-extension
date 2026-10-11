# Verify: PA-1
base-branch: refactor/pa-1-ports
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（93 pass / 12 files / 0 fail），与 result 声明的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/ports/*` 新增 + `tests/engine/router.test.ts` 的 import 调整）
- [ ] 逐条核对 pa-1.md 的 acceptance
- [ ] `rg "api/types" src/ports` 仅命中 `ports/types.ts`
- [ ] `src/ports/*` 只含 interface/type/常量，无运行时逻辑
- [ ] `src/engine/*`、`src/bridge/*` 行为逻辑未改（仅允许 router.test import 指向）
- [ ] 抽查关键回归语义仍被断言覆盖（D3/D9/D13/D16 等 engine 用例未因本阶段被删改）

verdict-report: 写 `/tmp/pi-tasks/pa-1.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-1-verify`
