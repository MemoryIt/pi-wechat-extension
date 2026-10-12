# Task: RF-2 会话生命周期收拢到 application/session

base: dev
branch: refactor/rf-2-session
model: opencode-go/deepseek-v4-flash
start: pi --approve --provider opencode-go --model deepseek-v4-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 138 pass / 16 files / 0 fail（不得减少；新增用例计入）
invariant: 行为不变；事件时序、公共 API、持久化格式、redact 规则、所有用户可见文案不得改变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## goal
把「会话生命周期」从 `src/bridge/` 收拢到 `src/application/session.ts` 的 `SessionService`：
- `session_start` 自动连接、`/wechat login|start|stop|logout|status`、`session_shutdown` 全部经
  `SessionService` 的唯一入口；所有「启动轮询」路径共用同一个私有方法，消除分叉。
- `bridge/commands.ts` 只保留 pi 命令注册、子命令分发与补全；`bridge/events.ts` 只做事件翻译；
  `bridge/login.ts` 的逻辑并入 `SessionService`，原文件删除。
- 本阶段**不改变任何对外行为**：所有 `ui.notify` 文案、二维码展示、登录成功摘要（脱敏）、
  存储调用集合、轮询错误提示必须逐字保持。

## scope
- prod（新增）：
  - `src/application/session.ts`（`SessionService`、`SessionUi`、`SessionChannel`）
  - `src/bridge/session-ui.ts`（把 `ctx`/`console`/`qrcode-terminal` 适配为 `SessionUi`）
- prod（修改）：
  - `src/bridge/commands.ts`：保留 `registerCommand` + completions + 子命令分发；操作委托 session
  - `src/bridge/events.ts`：`session_start` → `session.startFromStoredToken(ui)`；
    `session_shutdown` → `session.shutdown()`；`registerBridge(..., session)` 增加参数
  - `src/index.ts`：`new SessionService({ channel, auth, logger })` 并注入 commands/bridge
- prod（删除）：
  - `src/bridge/login.ts`（逻辑移入 session）
- tests（新增）：
  - `tests/application/session.test.ts`

## interface（建议；可微调，但保持窄）
```ts
// src/application/session.ts
export interface SessionUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  log(message: string): void;
  showQr(qrcodeUrl: string): void;
}
export interface SessionChannel {
  readonly connectionState: string;
  setConfig(config: WechatApiOpts): void;
  startPolling(opts: WechatApiOpts): Promise<void>;
  stopPolling(): void;
  reset(): void;
}
export class SessionService {
  constructor(deps: { channel: SessionChannel; auth: WechatAuth; logger: PluginLogger });
  startFromStoredToken(ui: SessionUi): Promise<void>;   // session_start 自动连接
  login(ui: SessionUi): Promise<void>;                  // 扫码登录
  start(ui: SessionUi): Promise<void>;                  // /wechat start
  stop(ui: SessionUi): void;                            // /wechat stop
  logout(ui: SessionUi): Promise<void>;                 // /wechat logout
  status(ui: SessionUi): Promise<void>;                 // /wechat status
  shutdown(): void;                                     // session_shutdown
}
```

## 行为契约（必须逐条保持，文案逐字一致）
- `session_start`：若 `getDefaultAccountToken()` 有 token → `setConfig` + `startPolling`，失败用
  `logger.error("Polling error:", err.message)`；无 token 只 `logger.debug`。
- `/wechat start`：无 token → `notify("WeChat: Not logged in. Use /wechat login first.", "error")`；
  有 token → `setConfig` → `notify("WeChat: Starting polling...", "info")` → `startPolling`，
  失败 `notify(\`Polling error: ${err.message}\`, "error")`。
- `/wechat status`：有 token →
  `notify(\`WeChat: Logged in\nUser ID: ${token.userId}\nConnection: ${channel.connectionState}\`, "info")`；
  否则 `notify("WeChat: Not logged in", "info")`。
- `/wechat stop`：`stopPolling` → `notify("WeChat: Stopped polling", "info")`。
- `/wechat logout`：`channel.reset()` → 有 token 则 `deleteAccountData` + `removeAccount` +
  `notify("WeChat: Logged out successfully", "info")`；否则 `notify("WeChat: Not logged in", "info")`。
- `/wechat login`（原 `performWechatLogin` 行为整体保持）：
  - `startQr` 无 qrcodeUrl → `notify(\`Failed to get QR code: ${startResult.message}\`, "error")`；
  - 有则 `notify("请使用微信扫描二维码...", "info")` → `ui.showQr(url)`；
  - `waitForLogin` connected → `saveToken` → `upsertAccount` → `notify("✅ 与微信连接成功！", "info")`
    → `setConfig` → `startPolling`（失败 `notify(\`启动轮询失败: ${err.message}\`, "error")`）
    → 脱敏摘要（`redactToken`）经 `ui.log` 打印；
  - 未 connected → `notify(\`登录失败: ${loginResult.message}\`, "error")`；
  - 外层异常 → `logger.debug("performWechatLogin failed:", err)` +
    `notify(\`登录异常: ${String(err)}\`, "error")`。
- `session_shutdown`：`stopPolling` + `reset`。
- **所有启动轮询路径必须经同一个私有方法**（`setConfig` 与 `startPolling` 只出现一处）。

## 依赖方向约束
- `src/application/**` 不得 import：
  `@earendil-works/pi-coding-agent`、`bridge/**`、vendor（`api/ auth/ cdn/ media/ messaging/ util/`）、
  `../channel/channel.js`。允许 import `../storage/state.js`、`../ports/auth.js`、`../shared/*`。
- `qrcode-terminal`、`console` 只允许出现在 `src/bridge/session-ui.ts`，不得进入 application。

## test-plan
新增 `tests/application/session.test.ts`（fake `SessionChannel` + fake `auth` + fake `SessionUi` +
真实 storage + 临时 agent dir）：
- [ ] `start`：有 token → `setConfig` + `startPolling` + 文案；无 token → 错误文案、不启动
- [ ] `startFromStoredToken`：有/无 token 两路
- [ ] `status`：登录/未登录两路文案
- [ ] `stop`：`stopPolling` + 文案
- [ ] `logout`：`reset` + 删除账户 + 文案；未登录文案
- [ ] `login` 成功：`saveToken`/`upsertAccount`/`setConfig`/`startPolling` + 成功文案 + 摘要不出现明文 token
- [ ] `login` 未 connected：失败文案
- [ ] `shutdown`：`stopPolling` + `reset`

## acceptance
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，用例数 ≥ 138
- [ ] 新增 `src/application/session.ts`、`src/bridge/session-ui.ts`、`tests/application/session.test.ts`；
      `src/bridge/login.ts` 已删除
- [ ] `rg "startPolling|setConfig" src/bridge` 无命中（启动路径已收拢）
- [ ] `rg "getDefaultAccountToken|deleteAccountData|removeAccount|saveToken|upsertAccount" src/bridge` 无命中
- [ ] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
- [ ] `rg "qrcode-terminal" src/application` 无命中
- [ ] 既有 `tests/bridge/event-wiring.test.ts`（D11/D20 等）与全量测试通过；未被削弱
- [ ] `git diff dev...HEAD --stat` 仅限上述文件
- [ ] 提交原子、message 规范

## forbidden
- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/channel/**`、`src/ports/**`、`src/adapters/**`、`src/application/reply.ts`、
  `src/application/types.ts`（如确需复用类型，可在 session.ts 内自行声明或新增文件）
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言（如需调整构造方式，最小改动）

## report
完成后写 `/tmp/pi-tasks/rf-2.result.md`（见总则 schema），执行：
`tmux wait-for -S task-rf-2`
