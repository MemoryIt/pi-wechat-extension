# Verify: CS-6 channel 内部装配工厂

base-branch: refactor/cs-6-channel-factory
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{create-channel,channel}.ts`、`tests/channel/**`）
- [ ] 逐条核对 `cs-6.md` 的 acceptance 与「行为契约」
- [ ] 新增 `src/channel/create-channel.ts`，导出 `createChannelRuntime`（及 `ChannelRuntime`）；
      工厂内完成全部 `new` + 回调注入
- [ ] `Channel` 构造函数仅「调用工厂 + 赋值」；`rg` 确认构造函数内无 `new MediaStore|new MessageRouter|new PollingLoop|new TypingController|new MessageSender|new InboundHandler|new SerialTaskQueue`
- [ ] `Channel` 已无 `sleep` / `mediaStore` / `mediaQueue` 字段（`rg` 无命中）
- [ ] `ChannelDeps` 与 `new Channel(...)` 用法不变；`src/index.ts` 零 diff；tests 无需改动
- [ ] 行为契约逐条等价：逐项比对工厂回调与原 Channel 构造函数（canSend/getHost/getOpts/
      isTerminalProcessing/ensureSession/getAccountId/onMessage/onNeedsRelogin/日志绑定/sleep/
      MediaStore log-errLog/requestId 注入）语义一致
- [ ] `Channel` 公共方法与四个窄接口契约不变
- [ ] **审计 tests/** 的 diff**（若为空，确认“无测试改动”合理：构造路径经 Channel 覆盖工厂）；
      若有改动，按 ledger 核对「迁移 / 被蕴含 / 失效」且无削弱
- [ ] **交叉核对 src↔tests**：工厂被 `Channel` 构造间接覆盖；无未覆盖的新公共行为
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-6.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-6-verify`
