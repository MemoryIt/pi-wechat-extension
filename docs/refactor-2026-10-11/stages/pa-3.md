# Task: PA-3 engine 改用端口 + 测试 mock 迁移到端口 fake

base: dev
branch: refactor/pa-3-engine-use-ports
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 114 pass / 13 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、WechatEngine 公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
让自写代码（`src/engine/*`、`src/bridge/login.ts`）**不再直接 import vendor**，改经 S1/S2 的 ports/adapters；
同时把 L2 测试的 mock 从 **vendor 模块路径** 迁移到 **端口 fake 注入**。
`WechatEngine` 的公共方法签名与外部行为保持不变（本阶段不做组合根改造，也不删门面）。

## scope
- prod：
  - `src/ports/outbound.ts`（**调整**：`sendTyping(status: 1|2, ticket: string): Promise<void>`）
  - `src/adapters/outbound.ts`（**改为薄实现**：删除内部 ticket 缓存；`getTypingTicket` 直连 getConfig；`sendTyping(status, ticket)` 直连 sendTyping）
  - `src/adapters/inbound.ts`（**修正回落**：`cursor: resp.get_updates_buf ?? params.cursor`，对齐旧 PollingLoop 的“缺字段回落旧 cursor”语义）
  - `src/engine/polling.ts`（经 `PollingLoopDeps.inbound` 调用端口；用 `{messages, cursor}`）
  - `src/engine/typing.ts`（`TypingDeps.outbound` 替代 getCredentials+getConfig/sendTyping；**保留自身 ticket 缓存/TTL/invalidateTicket/"ticket" 清缓存**）
  - `src/engine/sender.ts`（`SenderDeps.outbound` 替代 getCredentials + sendMessageWeixin/sendWeixinMediaFile）
  - `src/engine/media-store.ts`（经 `WechatMedia` 端口下载；落盘策略仍在本类；`MediaStoreOptions.media?` 可注入）
  - `src/engine/wechat.ts`（构造 adapters 并注入协作类：`createWechatInbound/Outbound/Media`；构造函数接受可选注入 `{ inbound?, outbound?, media? }` 供测试；类型 import 改 `../ports/types.js`）
  - `src/engine/router.ts`（类型 import 改 `../ports/types.js`）
  - `src/bridge/login.ts`（改经 `createWechatAuth()` 或注入的 `WechatAuth`，不再 import vendor auth）
- tests：
  - `tests/setup/engine-harness.ts`（**核心**：删除对 vendor 路径的 `mock.module`，改为提供 fake ports 并通过构造函数注入）
  - `tests/engine/engine.test.ts`、`tests/engine/media-store.test.ts`、`tests/engine/router.test.ts`（断言改挂 fake ports）
  - `tests/unit/adapters.test.ts`（同步 outbound 新签名：`sendTyping(status, ticket)`、无内部缓存）

## 设计要求（务必遵循）
1. **端口薄、缓存留在 TypingController**：
   - `WechatOutbound.getTypingTicket()` = 直连 `getConfig`（无缓存）
   - `WechatOutbound.sendTyping(status, ticket)` = 直连 `sendTyping`
   - `TypingController.getTicket()` 保留 60s TTL + contextToken 绑定 + `invalidateTicket()` + 报错含 "ticket" 清缓存
2. **PollingLoop** 通过 `deps.inbound.getUpdates({cursor, baseUrl, token, timeoutMs})`，使用返回的 `{messages, cursor}`；
   保留 generation 令牌、abort-race、重入守卫、needs_relogin 终态、（旧 cursor 回落由 adapter 完成）。
3. **MediaStore** 通过 `media.download(item, {cdnBaseUrl, saveMedia, label})`；
   `saveMedia` = `async (buf, contentType, originalFilename) => ({ path: this.save(buf, contentType, originalFilename) })`；
   落盘目录/魔数/命名仍在本类；单项失败记录后继续。
4. **WechatEngine 公共 API 不变**（方法名/签名/返回一致）；仅内部实现改经端口。
5. **测试用端口 fake**：`engine-harness` 暴露 `inboundMock`/`outboundMock`/`mediaMock` 等 fake（含可重置与调用记录），
   经 `createWechatEngine({ inbound, outbound, media })` 注入；**不得**再 `mock.module` vendor 路径。
6. vendor 目录零改动。

## test-migration
**从 mock vendor 路径 → 注入 fake ports**（本阶段核心目标）。断言语义保持不变：
- D6（sendUserMessage 同步抛错释放）、D7（drain catch）、D9（stopPolling 快速退出）、D13（同毫秒 requestId 唯一）、
  D14（sendFile basename）、D16/D16b（typing ticket 缓存/失效、interval unref）、B5（媒体后台串行）等必须仍被覆盖。

## integration-test
N/A（S5 新增 channel 集成测试）

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，用例数 ≥ 基线（114），且既有用例语义不降
- [ ] `rg "from \"\.\./\.\./(api|messaging|media|auth)/" src/engine src/bridge` 为空
- [ ] `rg "api/types" src/engine src/bridge` 为空（改用 `ports/types`）
- [ ] `rg "\.\./\.\./(api|messaging|media|auth)/|\.\./\.\./util/" src/engine src/bridge` 为空
- [ ] `tests/setup/engine-harness.ts` 不再 `mock.module` vendor 路径（api/messaging/media）
- [ ] WechatEngine 公共 API 未变（diff 仅内部实现）
- [ ] `src/adapters/outbound.ts` 无内部缓存；`tests/unit/adapters.test.ts` 相应更新并通过
- [ ] vendor 目录（api/auth/cdn/media/messaging/util/types）零 diff
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录
- 不得改 `WechatEngine` 公共 API/行为语义
- 不得改 `src/bridge/events.ts`、`commands.ts`、`tool-send-file.ts` 行为
- 不得新增依赖
- 不得 push / 不得改 base 分支

## 建议提交拆分
1. `refactor(ports/adapters): outbound 薄化(ticket 参数) + inbound 游标回落`
2. `refactor(engine): 经 ports 访问微信边界（polling/typing/sender/media-store/wechat/router）`
3. `refactor(bridge): login 经 WechatAuth 端口`
4. `test(engine): mock 迁移到端口 fake`

## report
完成后写 `/tmp/pi-tasks/pa-3.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-3`
