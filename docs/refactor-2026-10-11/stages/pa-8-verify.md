# Verify: PA-8
base-branch: refactor/pa-8-docs-c4
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，测试数不变（127 pass / 15 files / 0 fail）
- [ ] `git diff dev...HEAD --stat` **不含** `src/**`、`tests/**`、vendor、package.json/bun.lock/tsconfig
- [ ] 逐条核对 pa-8.md 的 acceptance
- [ ] `rg "src/engine|engine/wechat|WechatEngine|createWechatEngine" docs README.md` 为空
- [ ] `docs/c4/03a-engine.puml`、`docs/c4/04-class-engine.puml` 不存在；`03a-channel.puml`、`04-class-channel.puml` 存在
- [ ] `docs/ARCHITECTURE.md` 与当前 `src/` 一致（分层、模块、依赖方向、测试分层、adapter 调用面）
- [ ] `.puml` 语法自洽：include 的宏可用、`_styles.puml` tag 一致、无悬空引用旧文件名
- [ ] 未虚构不存在的模块/接口
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-8.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-8-verify`
