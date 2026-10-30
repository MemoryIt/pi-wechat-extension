# Verify: PA-2
base-branch: refactor/pa-2-adapters
mode: 只读（禁止修改代码/提交；只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿（贴计数）
- [ ] 测试数 ≥ 基线（93 pass / 12 files / 0 fail），与 result 声明的 test-changes 一致（新增 adapters 用例计入）
- [ ] `git diff dev...HEAD --stat` 未越界；**vendor 目录（api/ auth/ cdn/ media/ messaging/ util/）diff 必须为空**
- [ ] 逐条核对 pa-2.md 的 acceptance
- [ ] `rg "util/(redact|logger)" src` **仅命中** `src/shared/redact.ts` 与 `src/shared/file-logger.ts`
- [ ] `src/shared/redact.ts` / `src/shared/file-logger.ts` 为**薄再导出**（无逻辑复制）
- [ ] 4 个 adapter 正确实现 ports：
  - inbound 字段映射 `{msgs,get_updates_buf}`→`{messages,cursor}`
  - outbound `getTypingTicket` 有 60s TTL + contextToken 绑定 + "ticket" 错误清缓存
  - media 把 3 参 saveMedia 适配为 5 参回调，并按序挑选 decrypted*Path
  - auth 字段对齐端口
- [ ] adapter **未被** engine/bridge 接入（`rg "src/adapters" src/engine src/bridge` 为空）
- [ ] `src/ports/types.ts` 仅增量新增 `WechatCredentials`，既有接口未改
- [ ] `src/engine/*` 与 `src/bridge/{events,commands,tool-send-file}.ts` 行为逻辑未改（diff 为空）；`bridge/login.ts` 仅 import 变化
- [ ] 抽查关键回归语义仍被断言覆盖（D11 脱敏、D14 发送、D16 typing 等未退化）

verdict-report: 写 `/tmp/pi-tasks/pa-2.verify.md`（PASS/FAIL + 证据/命令输出），执行：
`tmux wait-for -S task-pa-2-verify`
