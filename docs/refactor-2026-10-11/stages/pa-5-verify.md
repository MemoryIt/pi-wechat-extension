# Verify: PA-5
base-branch: refactor/pa-5-channel-split
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（121 pass / 14 files / 0 fail），与 result 的 test-changes 一致
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录 diff 为空**；`src/bridge/*` diff 为空
- [ ] 逐条核对 pa-5.md 的 acceptance
- [ ] `src/channel/` 含 `channel.ts` + 原 engine 协作类（polling/queue/router/media-store/typing/sender）
- [ ] `src/engine/` 仅剩 `wechat.ts`；`rg "from \"\.\./engine" src/channel` 为空（channel 不反向依赖 engine）
- [ ] `WechatEngine` 公共 API 逐成员与 dev 一致；导出（engine/createWechatEngine/setPi/setConfig/WechatHost/WechatConfig/ConnectionState）不变
- [ ] WechatEngine 为**薄门面**：仅委托 Channel，不含原编排逻辑（抽查 handleMessage/triggerAi/initSingleUser/reset 已下沉）
- [ ] 集成测试存在且**真穿 Channel**（真 Channel + 假端口 + 假 PiHost），覆盖入站文本/媒体/typing/出站/ reset
- [ ] 集成测试未使用 `mock.module` vendor
- [ ] 协作类移动为**纯移动**（内容基本不变，仅 import 路径调整）；无逻辑漂移
- [ ] 关键回归语义仍覆盖：D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9
- [ ] 提交原子、message 规范

verdict-report: 写 `/tmp/pi-tasks/pa-5.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-5-verify`
