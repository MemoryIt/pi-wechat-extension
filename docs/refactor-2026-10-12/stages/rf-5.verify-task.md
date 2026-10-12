# Verify: RF-5
base-branch: refactor/rf-5-acl
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（160 pass / 18 files / 0 fail），与 `rf-5.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/adapters/*.ts`、`docs/vendor-constraints.md`、
      `tests/unit/adapters.test.ts`）
- [ ] `docs/vendor-constraints.md` 存在且含 6 个章节（目的/所有权/不可动耦合/低使用死代码/端口冻结/变更清单）
- [ ] 4 个 adapter 顶部有 ACL 注释；用 `git diff dev...HEAD -- src/adapters` 核对
      **非注释代码行零改动**（新增行以注释符号开头）
- [ ] 新增端口冻结用例覆盖：outbound 参数面、media/inbound/auth 参数面、vendor 5 参→端口 3 参不泄漏
- [ ] 端口签名未被改动（未给 `sendFile` 加 `to`，未改 `SaveMediaFn`）
- [ ] `src/ports/**`、`src/channel/**`、`src/bridge/**`、`src/application/**`、`src/storage/**`、
      `src/shared/**` diff 为空
- [ ] vendor diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-5.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-5-verify`
