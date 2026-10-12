# Task: RF-5 adapters 明确为 ACL + vendor 耦合文档 + 端口冻结

base: dev
branch: refactor/rf-5-acl
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 160 pass / 18 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；端口签名冻结；公共 API / 文案 / 持久化 / redact 不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## goal
把 `src/adapters/` 明确为 **Anti-Corruption Layer（ACL）**，并固化 vendor 边界：
1. 在 4 个 adapter 顶部加「ACL 职责 + 它吸收的 vendor 怪异」注释（**仅注释，无逻辑改动**）。
2. 新增 `docs/vendor-constraints.md`，集中记录所有与 vendor 的不可动耦合与维护规则。
3. 新增端口冻结回归测试，锁住端口参数面与「vendor 怪异在 adapter 内被吸收」的语义。

## scope
- prod（修改，**仅注释**）：
  - `src/adapters/inbound.ts`
  - `src/adapters/outbound.ts`
  - `src/adapters/media.ts`
  - `src/adapters/auth.ts`
- docs（新增）：
  - `docs/vendor-constraints.md`
- tests（修改）：
  - `tests/unit/adapters.test.ts`：新增「端口冻结 / ACL 契约」用例（复用文件已有的 vendor mock 与
    adapter 动态 import，不新建 mock 基建）。

## 端口冻结（不得改变）
- `WechatOutbound`：`sendText(text)` / `sendFile(localPath)` / `sendTyping(status, ticket)` / `getTypingTicket()`。
  **不**给 `sendFile` 加 `to`（单用户隐式）。
- `WechatMedia.download(item, deps)`；`SaveMediaFn = (buffer, contentType?, originalFilename?)`。
  vendor 的 `subdir` / `maxBytes` 由 adapter **有意丢弃**；落盘策略（ISO 周目录/命名）留在
  `src/channel/media-store.ts`。
- `WechatInbound.getUpdates(params)`；`WechatAuth.startQr(opts)` / `waitForLogin(opts)`。

## adapter 注释要求（每个文件顶部）
用一段注释说明：该 adapter 是唯一接触 vendor 的层、它把什么 vendor 形态翻译成端口形态、
哪些 vendor 概念被有意丢弃/隐藏、以及「不得把 vendor 类型/路径/全局状态泄漏回上层」。
至少覆盖：
- `inbound.ts`：`{msgs,get_updates_buf}` → `{messages,cursor}`；缺字段回落入参 cursor。
- `outbound.ts`：凭证来自注入 provider；固定 CDN 基址在 adapter 内；ticket 不缓存。
- `media.ts`：vendor 5 参 `saveMedia` → 端口 3 参；`subdir="inbound"` / `maxBytes=100MB` 有意丢弃；
  返回按 Pic>Voice>File>Video 取第一个非空。
- `auth.ts`：`login-qr` 两步包装；`botType` 缺省用 `DEFAULT_ILINK_BOT_TYPE`。

## vendor-constraints.md 必须包含的章节
1. **目的与维护规则**：vendor 冻结；新增微信边界调用只经 `src/adapters/`；不试图统一 vendor logger
   或修反向 import。
2. **所有权与目录**：`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts` 视为第三方。
3. **已知不可动耦合（逐条：位置 / 性质 / 影响 / 应对）**：
   - `vendor/messaging/inbound.ts` 反向 import `../src/storage/state-dir.js`
     （**类型导入，运行时通常不加载**）→ `src/storage/state-dir.ts` 必须继续导出 `resolveStateDir`。
   - `vendor/messaging/send.ts` 依赖私有类型 `openclaw/plugin-sdk/reply-runtime`
     → 靠根目录 `types/openclaw-plugin-sdk.d.ts` ambient 声明。
   - vendor 内部 10 处直接使用 `vendor/util/logger.ts`（写 `$TMPDIR/openclaw-YYYY-MM-DD.log`、
     读 `OPENCLAW_LOG_LEVEL`）→ 无法拦截；`src/shared/file-logger.ts` 只是再导出边界，目标是**隔离**不是统一。
   - vendor `getUpdates` 不接受 `AbortSignal`，客户端超时 35s；与 `src/channel/polling.ts` 的
     35s 常量重复。
   - vendor `messaging/inbound.ts` 的 context token store 会写旧路径
     `~/.pi/agent/.../openclaw-weixin/...`（当前自写路径未调用）。
   - vendor `saveMedia` 为 5 参（含 `subdir` / `maxBytes`）。
4. **低使用 / 死代码**：`messaging/markdown-filter.ts`（`send.ts` 再导出 `StreamingMarkdownFilter` 但无人消费）、
   `messaging/inbound.ts`（仅 `media/media-download.ts` 以 `import type` 引用）。删除前需评估调用面。
5. **端口冻结与责任边界**（见上「端口冻结」）。
6. **变更检查清单**：改 vendor 边界前后要跑哪些测试 / 检查哪些 rg。

## test-plan（加在 `tests/unit/adapters.test.ts`）
新增「端口冻结 / ACL 契约」小节：
- [ ] `WechatOutbound` 方法参数面：`sendText.length===1`、`sendFile.length===1`、
      `sendTyping.length===2`、`getTypingTicket.length===0`（禁止给 sendFile 加 `to`）。
- [ ] `WechatMedia.download.length===2`；`WechatInbound.getUpdates.length===1`；
      `WechatAuth.startQr.length===1` / `waitForLogin.length===1`。
- [ ] ACL 吸收语义：vendor 以 5 参调用 `saveMedia`（`"inbound"`, `100`, `"orig.png"`）时，
      端口 `saveMedia` **只收到 3 参** `(buffer, contentType, originalFilename)`，
      `subdir`/`maxBytes` 不泄漏（断言 `mock.calls[0].length===3` 且值正确）。

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 160
- [ ] `docs/vendor-constraints.md` 存在且含上述 6 个章节
- [ ] 4 个 adapter 顶部有 ACL 注释；`git diff` 中 adapter 的**非注释代码行零改动**
- [ ] `tests/unit/adapters.test.ts` 新增端口冻结用例并通过
- [ ] `git diff dev...HEAD --stat` 仅限 `src/adapters/*.ts`、`docs/vendor-constraints.md`、
      `tests/unit/adapters.test.ts`
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/channel/**`、`src/bridge/**`、`src/application/**`、
  `src/storage/**`、`src/shared/**`
- 不得改变任何 adapter 的**运行时逻辑**（只加注释）
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言

## report
完成后写 `/tmp/pi-tasks/rf-5.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-5`
