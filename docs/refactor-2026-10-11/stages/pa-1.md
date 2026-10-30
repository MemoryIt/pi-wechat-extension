# Task: PA-1 ports 接口定义（零行为变化）

base: dev
branch: refactor/pa-1-ports
model: opencode-go/deepseek-flash
start: pi --provider opencode-go --model deepseek-flash --no-extensions   # TUI
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 93 pass / 12 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公共 API、持久化格式、redact 规则不得改变
commit: 原子提交（一个逻辑变更一个 commit）；禁止 push；禁止改 base 分支

## goal
定义轻量 Ports & Adapters 的端口接口与类型边界，为后续 adapter/迁移做准备。**本阶段无任何运行时行为变化**：不改 engine/bridge 的调用逻辑。

## scope
- prod（新增）：
  - `src/ports/inbound.ts`    → `WechatInbound`
  - `src/ports/outbound.ts`   → `WechatOutbound`
  - `src/ports/media.ts`      → `WechatMedia`（含 `SaveMediaFn`）
  - `src/ports/auth.ts`       → `WechatAuth`
  - `src/ports/pi-host.ts`    → `PiHost`（即现 `WechatHost` 的等价窄接口）
  - `src/ports/types.ts`      → 类型边界（单一受控 re-export）
- tests：
  - `tests/engine/router.test.ts`（仅把 `WechatHost` 的 import 指向 `ports/pi-host`，语义不变）

## 接口建议（可微调，但保持“极薄、只含通道真正需要的操作”）
- `WechatInbound.getUpdates({ cursor, baseUrl, token, timeoutMs? })` → `{ messages, cursor }`（或等价结构，字段名与本阶段实现一致即可）
- `WechatOutbound`: `sendText(text)`, `sendFile(localPath)`, `sendTyping(status: 1|2)`, `getTypingTicket()`
  - 凭证由 adapter 构造时注入的 provider 提供，端口方法不带凭证参数
- `WechatMedia.download(item, { cdnBaseUrl, saveMedia, label? })` → `{ path } | null`
  - `SaveMediaFn = (buffer, contentType?, originalFilename?) => Promise<{ path }>`
  - **落盘策略（ISO 周目录/魔数/命名）不属于端口**，由 channel 侧回调实现
- `WechatAuth.startQr(opts)` / `waitForLogin(opts)`（字段对齐现有 `auth/login-qr` 用法）
- `PiHost.appendEntry(...)` / `sendUserMessage(...)` / `sendMessage(...)`（与现 `WechatHost` 一致）
- `src/ports/types.ts`：**只在此处** re-export 现有 `api/types` 的 `WeixinMessage` / `MessageItem` / `MessageItemType`

## test-migration
N/A（本阶段不改 mock 目标）

## integration-test
N/A

## acceptance
- [ ] `bun run typecheck && bun run test` 全绿，且既有用例数不减少（总数 ≥ 基线）
- [ ] 新增 `src/ports/*` 接口；无运行时逻辑（只有 interface/type/常量）
- [ ] `rg "api/types" src/ports` 仅出现在 `ports/types.ts`（单一受控类型边界）
- [ ] engine/bridge 的调用逻辑与运行时行为**未改变**
- [ ] `tests/engine/router.test.ts` 仍通过
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 `src/engine/*`、`src/bridge/*` 的行为逻辑（仅允许 router.test 的 import 指向调整）
- 不得引入新依赖
- 不得 push / 不得改 base 分支

## report
完成后写 `/tmp/pi-tasks/pa-1.result.md`（见总则 schema），执行：
`tmux wait-for -S task-pa-1`
