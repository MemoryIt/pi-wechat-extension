# Verify: PA-9
base-branch: refactor/pa-9-index-assembles-adapters
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（127 pass / 15 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录 diff 为空**；`src/bridge/**` diff 为空
- [ ] 逐条核对 pa-9.md 的 acceptance
- [ ] `rg "adapters" src/channel` 为空（channel 不再依赖 adapters）
- [ ] `src/index.ts` 组装 `ChannelState` + 3 个 adapter + `Channel`；outbound 的 `getCredentials` 读同一 state 实例
- [ ] `ChannelPorts` 三字段与 `ChannelDeps.ports` 必填；无缺省 adapter 构造
- [ ] `ChannelState.getCredentials()/getOpts()` 存在且语义与迁移前一致
- [ ] 行为不变：抽查凭证/typing ticket/sender canSend/media/reset 断言未弱化
- [ ] docs 无「过渡/待迁 index/channel 缺省构造 adapters」残留
- [ ] 关键回归用例 D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9 + 集成用例全绿
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-9.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-9-verify`
