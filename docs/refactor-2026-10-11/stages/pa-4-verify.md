# Verify: PA-4
base-branch: refactor/pa-4-channel-state
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（115 pass / 13 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录 diff 为空**
- [ ] 逐条核对 pa-4.md 的 acceptance
- [ ] `src/channel/state.ts` 存在且只承载状态/`resetSession()`，**无 channel → engine 反向依赖**（`rg "from \"../engine" src/channel` 为空）
- [ ] `WechatEngine` 公共 API 逐成员比对与 dev 一致（方法名/签名/返回；仅内部字段改走 state）
- [ ] `resetSession()` 语义：清凭证/终端标志/请求计数；**保留** config/host/notifier（对照旧 `reset()`）
- [ ] 协作类（PollingLoop/TurnQueue/SerialTaskQueue/TypingController/MessageSender/MediaStore/MessageRouter）仍是独立类，未被并入 ChannelState
- [ ] `sendWithRetry` 缺凭证：立即抛 `"Single user not initialized"`，**不调用** `outbound.sendText`，不进入重试/sleep（有测试覆盖）
- [ ] `src/bridge/{events,commands,tool-send-file}.ts` 行为未改（diff 为空）；`login.ts` 无回归
- [ ] 关键回归语义仍覆盖：D6/D7/D9/D13/D14/D16/D16b/B5 等未退化
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-4.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-4-verify`
