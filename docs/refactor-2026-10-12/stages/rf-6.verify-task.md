# Verify: RF-6
base-branch: refactor/rf-6-channel-slim
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（163 pass / 18 files / 0 fail），与 `rf-6.result.md` 声明一致
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{channel,state,request-id}.ts`、
      `src/bridge/{events,tool-send-file}.ts`、`src/index.ts`、`tests/**`）
- [ ] 逐条核对 `rf-6.md` 的 acceptance 与「不变量」
- [ ] `rg "configure\(|cleanupProcessedRequests" src/channel/channel.ts tests` 无命中
- [ ] `rg "lastRequestIdMs|requestIdSeq" src tests` 无命中
- [ ] `RequestIdGenerator` 新增且被 `Channel` 委托；D13 用例未改动且通过
- [ ] `rg "channel/channel" src/bridge` 无命中；`bridge` 只用窄接口
- [ ] `ChannelState` 字段收敛（无 requestId 字段）；`resetSession` 语义不变
- [ ] `src/channel/` 下 polling/queue/router/media-store/typing/sender 及 `src/channel/channel.ts`
      的其余公共方法签名/行为未变；`src/ports`、`src/adapters`、`src/application` diff 为空
- [ ] vendor diff 为空、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/rf-6.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-rf-6-verify`
