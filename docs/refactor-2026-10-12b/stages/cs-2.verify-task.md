# Verify: CS-2 入站消息解析器抽取

base-branch: refactor/cs-2-inbound-parser
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{inbound-parser,channel,router}.ts`、`tests/channel/**`）
- [ ] 逐条核对 `cs-2.md` 的 acceptance 与「行为契约」
- [ ] `src/channel/inbound-parser.ts` 存在且导出 `parseInbound`；纯函数、无副作用、只依赖 `ports/types`
- [ ] `src/channel/channel.ts` 无 `extractText` / `isSlashCommand`（`rg` 无命中）；slash/文本路径改用 `parseInbound`
- [ ] `src/channel/router.ts` `execute()` 无内联 `item_list?.some(...)` 判定与文本拼接；改用 `parseInbound`
- [ ] 解析语义逐字等价：
      `text` 以 `"\n"` 拼接且不 trim；`isCommand` 遍历全部 TEXT 项且 `trim().startsWith("/")`；
      `hasText` 用 `text_item?.text?.trim()` 真值；`hasMedia` 为存在非 TEXT 项；空消息四字段全空
- [ ] slash 早退顺序不变（先于 contextToken 更新与 AI 派发）
- [ ] `Channel` 公共方法与四个窄接口（BridgeChannel/SendFileChannel/ReplyChannel/SessionChannel）契约不变
- [ ] **审计 tests/** 的 diff**：每个删除/修改用例都能按 ledger 对应到「迁移 / 被蕴含 / 失效」；
      抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：被改的公共方法/类，其测试去向已覆盖
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-2.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-2-verify`
