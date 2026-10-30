# Verify: RF-4
base-branch: refactor/rf-4-connecting
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（158 pass / 18 files / 0 fail），与 `rf-4.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/polling.ts`、`tests/channel/channel.test.ts`）
- [ ] 逐条核对 `rf-4.md` 的 acceptance 与「行为契约」
- [ ] `start()` 在 `ensureSession()` 前同步置 `connecting`；无凭证失败后回到 `disconnected`（不卡 connecting）
- [ ] 新增 A3 用例确实覆盖「首次 getUpdates 返回前 === connecting」「返回后 === connected」
- [ ] `stop()` / `reset()` / `needs_relogin` 语义未回退；重入守卫未改变
- [ ] 未引入 `SessionService.phase` 或第二份连接状态；无 vendor/依赖改动
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-4.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-4-verify`
