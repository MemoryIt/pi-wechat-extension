# Verify: PA-3
base-branch: refactor/pa-3-engine-use-ports
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（114 pass / 13 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录（api/ auth/ cdn/ media/ messaging/ util/ types/）diff 为空**
- [ ] 逐条核对 pa-3.md 的 acceptance
- [ ] `rg "from \"\.\./\.\./(api|messaging|media|auth)/" src/engine src/bridge` 为空
- [ ] `rg "api/types" src/engine src/bridge` 为空；类型来自 `ports/types`
- [ ] `tests/setup/engine-harness.ts` 不再 `mock.module` vendor（api/messaging/media）；改为端口 fake 注入
- [ ] 端口薄化正确：`WechatOutbound.sendTyping(status, ticket)`；`getTypingTicket` 无缓存
- [ ] `TypingController` 仍保留：60s TTL + contextToken 绑定 + `invalidateTicket()` + "ticket" 清缓存
- [ ] `PollingLoop` 仍保留：重入守卫/generation/abort-race/needs_relogin 终态；（游标回落由 adapter `?? params.cursor` 保证）
- [ ] `MediaStore` 落盘策略仍在自写侧；media 端口仅负责下载解密
- [ ] `WechatEngine` 公共 API 未变（对比方法名/签名；diff 仅内部实现）
- [ ] `src/bridge/events.ts`/`commands.ts`/`tool-send-file.ts` 行为未改（diff 为空）；`login.ts` 仅改为经 auth 端口
- [ ] 关键回归语义仍被断言覆盖：D6/D7/D9/D13/D14/D16/D16b/B5 未退化（逐条指出用例仍在且通过）
- [ ] 不存在对 vendor 的隐式 mock 残留（`rg "mock.module" tests/setup/engine-harness.ts` 空）

verdict-report: 写 `/tmp/pi-tasks/pa-3.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-3-verify`
