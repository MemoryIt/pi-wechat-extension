# Task: PA-2 adapters 薄包装 + 工具边界收口（不接入 engine）

base: dev
branch: refactor/pa-2-adapters
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 93 pass / 12 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## 背景修正（重要）
`util/redact.ts`、`util/logger.ts` 被 **vendor 内部**（api/auth/cdn/media/messaging）大量引用，
**不可移动/删除**。因此本阶段不做“移动”，改为在 `src/shared/` 建**薄再导出边界**，
把自写代码的 import 收口过去；vendor 原文件保持不动。

## goal
实现 4 个微信侧 adapter（薄包装现有 vendor 函数，实现 S1 的 ports），并把自写代码对
`util/redact`、`util/logger` 的直接依赖收口到 `src/shared/` 的两个再导出边界。
**本阶段不把 adapter 接入 engine/bridge**（接入在 S3）。

## scope
- prod（新增）：
  - `src/adapters/inbound.ts`   → `createWechatInbound()` 实现 `WechatInbound`
  - `src/adapters/outbound.ts`  → `createWechatOutbound({ getCredentials, logger? })` 实现 `WechatOutbound`
  - `src/adapters/media.ts`     → `createWechatMedia({ log?, errLog? })` 实现 `WechatMedia`
  - `src/adapters/auth.ts`      → `createWechatAuth()` 实现 `WechatAuth`
  - `src/shared/redact.ts`      → 薄再导出：`export { redactToken, redactBody, redactUrl } from "../../util/redact.js"`
  - `src/shared/file-logger.ts` → 薄再导出：`export { logger, setLogLevel } from "../../util/logger.js"`
- prod（小改）：
  - `src/ports/types.ts`（仅**增量**：加 `export interface WechatCredentials { baseUrl; token; userId; contextToken }`）
  - `src/shared/logger.ts`（redact import 改为 `./redact.js`）
  - `src/bridge/login.ts`（redact import 改为 `../shared/redact.js`；**不改逻辑**）
  - `src/storage/state.ts`（logger import 改为 `../shared/file-logger.js`；**不改逻辑**）
- tests：
  - 新增 `tests/unit/adapters.test.ts`
  - 如 `tests/setup/mocks.ts` 无需改动则不改（`util/logger.js` 仍被 mock，再导出可命中）

## adapter 实现要点
- **inbound**：包装 `api/api.getUpdates`，把 `{ msgs, get_updates_buf }` 映射为 `{ messages, cursor }`。
- **outbound**：
  - `sendText` → `messaging/send.sendMessageWeixin({ to: userId, text, opts:{baseUrl,token,contextToken} })`
  - `sendFile` → `messaging/send-media.sendWeixinMediaFile({ filePath, to: userId, text:"", opts, cdnBaseUrl })`
  - `getTypingTicket` → `api/api.getConfig({ baseUrl, token, ilinkUserId: userId, contextToken })`；
    **实现 60s TTL 缓存且绑定 contextToken**（token 变化即失效；错误信息含 "ticket" 时清缓存）；失败/凭证缺失返回 null
  - `sendTyping(status)` → 取缓存的 ticket 后 `api/api.sendTyping({ baseUrl, token, body:{ ilink_user_id, typing_ticket, status } })`；
    无 ticket 时按现行为记录并返回（不抛）
  - 凭证来自构造注入的 `getCredentials()`；端口方法不带凭证参数
- **media**：包装 `media/media-download.downloadMediaFromItem(item, { cdnBaseUrl, saveMedia, log, errLog, label })`：
  - 把端口 3 参 `SaveMediaFn` 适配为 vendor 需要的 5 参回调
    `(buffer, contentType, _subdir, _maxBytes, originalFilename) => saveMedia(buffer, contentType, originalFilename)`
  - 从返回的 `decryptedPicPath/Voice/File/Video` 按序取第一个非空 → `{ path }`；无则 `null`
  - **落盘策略继续由调用方（channel）注入，adapter 不做目录/命名/魔数逻辑**
- **auth**：包装 `auth/login-qr` 的 `startWeixinLoginWithQr` / `waitForWeixinLogin`（含 `DEFAULT_ILINK_BOT_TYPE`），字段对齐端口。

## test-migration
**起点**：`tests/unit/adapters.test.ts` 用 `mock.module` 包装 vendor 模块路径，
断言 adapter 的映射/缓存/回调适配行为（S3 将改为端口 fake 注入，本阶段先建立基线用例）。

## integration-test
N/A

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，且用例数 ≥ 基线 + 本阶段新增
- [ ] 4 个 adapter 实现对应 ports，且 `tests/unit/adapters.test.ts` 覆盖：inbound 映射、outbound 发送/缓存、media 回调适配与路径挑选、auth 字段映射
- [ ] `rg "util/(redact|logger)" src` **仅命中** `src/shared/redact.ts` 与 `src/shared/file-logger.ts`
- [ ] `src/engine/*`、`src/bridge/events.ts/commands.ts/tool-send-file.ts` 的**行为逻辑未改**（login.ts 仅 import 调整）
- [ ] 未把 adapter 接入 engine/bridge（registry 未变）
- [ ] `ports/types.ts` 仅**增量**添加 `WechatCredentials`，未改既有接口
- [ ] vendor 目录（api/auth/cdn/media/messaging/util）**零改动**
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor 目录任何文件
- 不得改动 `src/engine/*` 行为、不得改 `src/bridge/events.ts`、`commands.ts`、`tool-send-file.ts`
- 不得新增依赖
- 不得 push / 不得改 base 分支

## report
完成后写 `/tmp/pi-tasks/pa-2.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-2`
