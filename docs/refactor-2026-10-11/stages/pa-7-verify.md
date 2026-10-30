# Verify: PA-7
base-branch: refactor/pa-7-remove-engine
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（127 pass / 15 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录 diff 为空**
- [ ] 逐条核对 pa-7.md 的 acceptance
- [ ] `test -d src/engine` 为假；`rg "src/engine|engine/wechat" src tests` 为空
- [ ] `rg "\bWechatEngine\b|createWechatEngine" src tests` 为空（含注释）
- [ ] `tests/channel/` 存在（channel/media-store/queue/router）；`tests/setup/channel-harness.ts` 存在；`tests/setup/engine-harness.ts` 不存在
- [ ] 测试为**直接测 Channel**（非 WechatEngine 门面）；`tests/channel/channel.test.ts` 存在
- [ ] `tests/unit/dependencies.test.ts` 的 `CORE_FILES` 指 `src/channel/channel.ts` 且通过
- [ ] 回归用例仍在且通过：D3/D6/D7/D9/D13/D14/D15/D16(×3)/D16b/B4/B5(×2)/B6/C9（逐条列出）
- [ ] `tests/integration/channel-flow.test.ts`、`tests/unit/channel-state.test.ts` 未被削弱
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-7.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-7-verify`
