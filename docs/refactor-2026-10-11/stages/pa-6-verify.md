# Verify: PA-6
base-branch: refactor/pa-6-composition-root
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（126 pass / 15 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录 diff 为空**
- [ ] 逐条核对 pa-6.md 的 acceptance
- [ ] `rg "export const engine\b|export function setPi|export function setConfig" src` 为空（单例/模块函数移除）
- [ ] `rg "engine/wechat" src` 为空；`src/index.ts` 无 `./engine/wechat` import
- [ ] `src/index.ts` 提供 `createExtension(deps?)` + `export default createExtension()`；显式 `new Channel()` + `createWechatAuth()` + `piToHost`
- [ ] `tests/setup/bridge-harness.ts` 无对 `src/engine/wechat.js` 的 `mock.module`；改为注入 fake channel/auth
- [ ] bridge 注入驱动：`registerBridge(pi, channel)` / `registerCommands(pi, channel, auth)` / `createSendFileTool(channel)`；无 `setPi/setConfig` 模块调用
- [ ] 隔离性：两次 `createExtension()(pi)` 不共享 channel（测试或代码论证）
- [ ] `WechatEngine` 类与 `createWechatEngine` 仍导出；`tests/engine/engine.test.ts` 仍通过
- [ ] 关键回归语义仍覆盖：D11/D17/D18/D19/D20/D2/D5/D1/D4/D21（逐条指出用例仍在且通过）
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-6.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-6-verify`
