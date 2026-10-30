# Verify: CS-DOC 文档同步

base-branch: refactor/cs-doc-sync
mode: 只读（禁止修改/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（预期测试零改动，194 pass）
- [ ] `git diff dev...HEAD --stat` 仅限 `docs/**`、`tests/README.md`
- [ ] `git diff dev...HEAD -- src api auth cdn media messaging util types package.json bun.lock` 为空；
      `tests/**` 除 `tests/README.md` 外为空
- [ ] **历史档案零改动**：`git diff dev...HEAD -- docs/refactor-2026-10-11 docs/refactor-2026-10-12 docs/refactor-2026-10-12b/stages` 为空
- [ ] `rg "generateRequestId|isSlashCommand|extractText|handleSlashCommand" docs/ARCHITECTURE.md docs/c4` 无命中
- [ ] `docs/ARCHITECTURE.md`：
      §3.3 列出 `create-channel.ts`/`inbound-handler.ts`/`inbound-parser.ts`/`credential-loader.ts`；
      §4.3 requestId 归属改为 `InboundHandler`；§7.2 channel 文件清单含新文件；
      §2 结构示意反映 `MessageRouter` 拥有 `TurnQueue`
- [ ] `docs/c4/04-class-channel.puml`：`Channel` 成员与当前公共 API 一致（无 `getTerminalProcessing/
      getTypingTicket/sendTypingStatus/getCurrentRequestId/sendText/generateRequestId/isSlashCommand/
      extractText/handleSlashCommand`，字段无 `queue/requestId/mediaStore/mediaQueue/sleep`）；
      含 `InboundHandler`（持有 `RequestIdGenerator`）、`CredentialLoader`、`createChannelRuntime`、`parseInbound`
- [ ] `docs/c4/03a-channel.puml`：requestId 关系改由 `inbound-handler` 持有；新增组件存在
- [ ] `tests/README.md`：D13 指向 `request-id.test.ts`；D15 标注已移除；新增测试文件已同步
- [ ] 新增 `docs/refactor-2026-10-12b/README.md`（阶段总览/结果/最终结构）与
      `e2e-manual-2026-10-12b.md`（人工清单，标注未执行 + slash 行为变更）
- [ ] 文档陈述与代码事实一致（抽查：Channel 公共方法集、create-channel 装配、inbound-handler 职责、
      requestId 归属、MessageRouter 拥有队列）；无自相矛盾
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-doc.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-doc-verify`
