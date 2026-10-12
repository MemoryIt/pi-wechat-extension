# Verify: RF-8
base-branch: refactor/rf-8-docs
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（171 pass / 20 files / 0 fail）
- [ ] `git diff dev...HEAD --stat` 仅含 `docs/**`；`src/`、`tests/`、`package.json`、`bun.lock`、
      vendor 零 diff
- [ ] 逐条核对 `rf-8.md` 的 acceptance 与具体要求
- [ ] `docs/ARCHITECTURE.md`：依赖方向含 `application/`；模块表含 `application/reply`、
      `application/session`、`bridge/session-ui`、`TurnResolver`/`MetaBuilder`、`channel/request-id`；
      关键机制含 ReplyService/SessionService/窄接口/RequestIdGenerator/A3 connecting/F6 隔离；
      引用 `docs/vendor-constraints.md`
- [ ] `docs/c4/03-components.puml` 含 `application` 组件且关系正确、PlantUML 结构自洽
- [ ] `docs/c4/04-class-channel.puml` 含 `RequestIdGenerator`，且 `Channel` 不再有
      `configure`/`cleanupProcessedRequests`
- [ ] `docs/refactor-2026-10-12/e2e-manual-2026-10-12.md` 含 A3 与 F6 重点项、A–K 结构与通过标准
- [ ] `docs/refactor-2026-10-12/README.md` 阶段表/结果汇总已更新
- [ ] 过时引用清查（`rg "WechatEngine|bridge/login|lastRequestIdMs" docs/ARCHITECTURE.md docs/c4 docs/refactor-2026-10-12/README.md` 无命中）
- [ ] `docs/refactor-2026-10-11/**`、`docs/vendor-constraints.md` 未被改动
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-8.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-8-verify`
