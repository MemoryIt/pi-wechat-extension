# Verify: RF-7
base-branch: refactor/rf-7-f6-resilience
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（167 pass / 19 files / 0 fail），与 `rf-7.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{polling,router}.ts`、`tests/channel/**`）
- [ ] 逐条核对 `rf-7.md` 的 acceptance 与「行为契约」
- [ ] `polling.ts`：单条 `onMessage` 失败被隔离（try/catch + error 日志），循环继续；
      批次成功时 `syncCursor`/`saveCursor` 仍执行
- [ ] `router.ts`：媒体 ack 失败被 try/catch 吞掉并记录；`mediaQueue.enqueue` /
      `markRequestProcessed` / `drain` 仍执行
- [ ] 新增 F6 回归用例确实覆盖「ack 失败 → 文本仍到达宿主 + cursor 持久化」；
      polling 用例覆盖「单条失败不阻断后续 + cursor 持久化」
- [ ] **验证修复前会失败**：在 `dev`（未修复）上跑新增用例应失败；在 HEAD 上通过
      （请实际在 dev 与 HEAD 两个状态下各跑一次新增用例并贴结果）
- [ ] 正常路径行为未变；`tests/channel/router.test.ts` 媒体基线用例未削弱
- [ ] `getUpdates` 自身失败的退避/错误逻辑未被改动（连接状态/失败计数）
- [ ] vendor diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-7.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-7-verify`
