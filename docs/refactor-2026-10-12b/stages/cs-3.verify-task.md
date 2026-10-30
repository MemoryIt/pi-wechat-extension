# Verify: CS-3 移除微信入站 slash 命令拦截

base-branch: refactor/cs-3-remove-slash-command
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{channel,inbound-parser}.ts`、`tests/channel/**`、`README.md`）
- [ ] 逐条核对 `cs-3.md` 的 acceptance 与「行为契约与变更声明」
- [ ] `src/channel/channel.ts`：无 `parseInbound` / `handleSlashCommand` / `isCommand`（`rg` 无命中）；
      `handleMessage` 现为「requestId → contextToken 更新/持久化 → triggerAi」
- [ ] `src/channel/inbound-parser.ts`：`ParsedInbound` 仅 `{ text, hasText, hasMedia }`；`rg "isCommand" src` 无命中
- [ ] `README.md` 不再有“以 / 开头被拦截、仅 /help 有响应”的过时描述；新描述与新行为一致
- [ ] **行为变更回归**：经 `Channel.handleMessage` 的 `"/foo"` 文本 → `host.sendUserMessage` 被调用、
      `outbound.sendText` 未被调用（用例存在且通过）
- [ ] 其它路径未变：非 slash 文本 / 纯媒体 / contextToken 更新+持久化 / typing 失效 /
      队列与防重（D1/D2/F6）用例仍通过
- [ ] pi 真实命令仍不被微信触发（README 的 by-design 说明保留，未被误删）
- [ ] **审计 tests/** 的 diff**：每个删除/修改用例都能按 ledger 对应到「迁移 / 被蕴含 / 失效」；
      本阶段 isCommand 用例删除属「失效（功能已移除）」，确认其断言的内部行为无对外可观察性；
      抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：被删的 `isCommand` / `handleSlashCommand` 无遗留测试引用；
      新增行为变更用例覆盖了移除后的新行为
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）；未删除 `Channel.sendText`
- [ ] 提交原子、message 规范；未 push
- [ ] 非阻塞观察：若条件允许，记录「vendor 是否亦拦截 `/`」的观察结论（不作为通过条件）

verdict-report: 写 `/tmp/pi-tasks/cs-3.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-3-verify`
