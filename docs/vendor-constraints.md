# vendor 约束与耦合说明（RF-5）

> 本文件记录 **pi-wechat-extension** 与 vendor（微信侧第三方代码）之间**不可动**的耦合、
> 维护规则与端口责任边界。配套阶段：`docs/refactor-2026-10-12/stages/rf-5.md`。

## 1. 目的与维护规则

- **vendor 冻结**：`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts` 视为第三方，
  除非上游升级，否则**零改动**（包括格式化、重命名、删除死代码）。
- **唯一入口**：所有对微信边界的调用**只经 `src/adapters/`**。任何新增的微信 API / 媒体 /
  登录调用都必须先落到端口（`src/ports/`），再由 adapter 包装 vendor，上层（`src/application/`、
  `src/bridge/`、`src/channel/`）不得直接 import vendor。
- **不做**：
  - 不试图统一 vendor logger（vendor 内部各模块直接 import `util/logger.ts`，无法拦截）；
  - 不修 vendor 的反向 import（见 §3.1）；
  - 不为 vendor 的私有类型引入真实依赖（用 ambient 声明，见 §3.2）；
  - 不把 vendor 类型 / 路径 / 全局状态泄漏回上层。
- **目标**是**隔离**（把 vendor 怪异挡在 adapter 内），不是**统一**（改造 vendor 本身）。

## 2. 所有权与目录

| 目录 / 文件 | 所有权 | 说明 |
|---|---|---|
| `api/` | vendor（第三方） | 微信 HTTP API（`api.ts`、协议类型 `types.ts`） |
| `auth/` | vendor（第三方） | 二维码登录（`login-qr.ts`、`accounts.ts`） |
| `cdn/` | vendor（第三方） | CDN 上传 / 下载 / 解密（AES-ECB、图片解密等） |
| `media/` | vendor（第三方） | 媒体下载复用、MIME 嗅探、silk 转码 |
| `messaging/` | vendor（第三方） | 收发消息、入站上下文、markdown filter |
| `util/` | vendor（第三方） | `logger.ts`、`random.ts`、`redact.ts` |
| `types/*.d.ts` | vendor 边界声明 | `openclaw-plugin-sdk.d.ts`（ambient）、`silk-wasm.d.ts` |
| `src/` | 本项目 | 唯一允许重构的目录；通过 `src/adapters/` 与 vendor 交互 |

## 3. 已知不可动耦合

### 3.1 `messaging/inbound.ts` 反向 import `../src/storage/state-dir.js`

- **位置**：`messaging/inbound.ts:8` → `import { resolveStateDir } from "../src/storage/state-dir.js";`
- **性质**：vendor 反向依赖自写层，且是**类型导入（type-only）**，运行时通常不加载。
- **影响**：`src/storage/state-dir.ts` 若被删除/重命名，类型检查会失败；模块解析也可能受影响。
- **应对**：`src/storage/state-dir.ts` **必须继续导出 `resolveStateDir`**（当前实现为
  `src/shared/paths.ts` 的 re-export）。不得改成默认导出或改名。

### 3.2 `messaging/send.ts` 依赖私有类型 `openclaw/plugin-sdk/reply-runtime`

- **位置**：`messaging/send.ts:1` → `import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";`
- **性质**：引用一个运行时不存在、仅类型使用的私有包（type-only import）。
- **影响**：若无声明，`tsc --noEmit` 报「找不到模块」。
- **应对**：靠根目录 `types/openclaw-plugin-sdk.d.ts` 的 **ambient 声明**满足类型检查。
  该声明保持宽松（`text?` + 索引签名），不得改成精确结构，以免随上游漂移而编译失败。

### 3.3 vendor 内部 10 处直接使用 `vendor/util/logger.ts`

- **位置**（10 个文件直接 import）：
  `api/api.ts`、`auth/login-qr.ts`、`cdn/pic-decrypt.ts`、`cdn/cdn-upload.ts`、`cdn/upload.ts`、
  `media/media-download.ts`、`media/silk-transcode.ts`、`messaging/send.ts`、
  `messaging/send-media.ts`、`messaging/inbound.ts`。
- **性质**：vendor logger 直接写 `$TMPDIR/openclaw-YYYY-MM-DD.log`（JSON lines），
  并从环境变量 `OPENCLAW_LOG_LEVEL` 读取级别。
- **影响**：这些写盘**无法被自写层拦截**；`src/shared/file-logger.ts` 只是自写代码侧的
  薄 re-export 边界，不能改变 vendor 内部行为。
- **应对**：接受该副作用；`src/shared/file-logger.ts` 的目标是**隔离**（方便日后替换），
  **不是统一** vendor 日志。不要试图删改 vendor logger 或改动其环境变量语义。

### 3.4 `getUpdates` 不接受 `AbortSignal`，客户端超时常量 35s 重复

- **位置**：`api/api.ts` → `DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000`；
  `src/channel/polling.ts` → `DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000`。
- **性质**：vendor `getUpdates` 只接受 `timeoutMs`，内部用 `AbortController` 自行超时，
  不接受外部传入的 `AbortSignal`；两个 35s 常量在不同层各写一份。
- **影响**：无法从上层取消 vendor 的 in-flight 长轮询；改动任一常量会出现行为不一致。
- **应对**：保持两份 35s 常量语义一致；端口 `WechatInboundGetUpdatesParams.timeoutMs`
  由调用方（`polling.ts`）显式透传。若未来要统一，应经端口收口而非改 vendor。

### 3.5 `messaging/inbound.ts` 的 context token store 会写旧路径

- **位置**：`messaging/inbound.ts` → `resolveContextTokenFilePath()` 组装
  `resolveStateDir()/openclaw-weixin/accounts/<accountId>.context-tokens.json`，
  即 `~/.pi/agent/.../openclaw-weixin/...`。
- **性质**：vendor 自带一套 contextToken 的进程内 Map + 落盘持久化（每账号一个文件）。
- **影响**：若被调用，会写到旧 `openclaw-weixin` 目录，与当前自写层路径不一致。
- **应对**：当前自写路径**未调用**该 store（`getContextToken`/`setContextToken` 等不被
  `src/` 使用）；不要主动接线，也不要修改 vendor 路径，保持「未调用」现状即可。

### 3.6 `saveMedia` 为 5 参（含 `subdir` / `maxBytes`）

- **位置**：`media/media-download.ts` → 内部 `SaveMediaFn` 类型为
  `(buffer, contentType?, subdir?, maxBytes?, originalFilename?)`；
  调用处传 `("inbound", WEIXIN_MEDIA_MAX_BYTES /* 100MB */, …)`。
- **性质**：vendor 把「落盘子目录」与「大小上限」一并压给回调。
- **影响**：若直接把它当端口签名，会把 vendor 的落盘策略泄漏到 `src/`。
- **应对**：由 `src/adapters/media.ts` 适配为端口 3 参
  `SaveMediaFn (buffer, contentType?, originalFilename?)`，**有意丢弃** `subdir`/`maxBytes`；
  落盘目录（ISO 周）/ 命名 / 魔数判断留在 `src/channel/media-store.ts`。

## 4. 低使用 / 死代码

| 位置 | 现状 | 说明 |
|---|---|---|
| `messaging/markdown-filter.ts` | 低使用 / 近似死代码 | `messaging/send.ts:11` 再导出 `StreamingMarkdownFilter`，但 `src/` 与 tests **无任何消费者**。 |
| `messaging/inbound.ts` | 低使用 | 仅 `media/media-download.ts:1` 以 `import type { WeixinInboundMediaOpts }` 引用；其余导出（contextToken store 等）在 `src/` 中未被调用。 |

**规则**：以上文件属 vendor，**不得在本项目内删除**。若上游允许清理，删除前必须先评估调用面
（至少 `rg "markdown-filter|StreamingMarkdownFilter"` 与 `rg "messaging/inbound"`），
并确认不在任何既接线的运行路径上。

## 5. 端口冻结与责任边界

端口签名**冻结**，adapter 只做翻译，**不改变**参数面：

| 端口 | 冻结签名 | 责任边界 |
|---|---|---|
| `WechatOutbound` | `sendText(text)` / `sendFile(localPath)` / `sendTyping(status, ticket)` / `getTypingTicket()` | **不**给 `sendFile` 加 `to`（单用户隐式，`to` 由 adapter 注入凭证提供）。ticket 不缓存，缓存/失效在 `TypingController`。 |
| `WechatMedia` | `download(item, deps)`；`SaveMediaFn = (buffer, contentType?, originalFilename?)` | vendor 的 `subdir`/`maxBytes` 由 adapter **有意丢弃**；落盘策略留在 `src/channel/media-store.ts`。 |
| `WechatInbound` | `getUpdates(params)` | `{msgs, get_updates_buf}` → `{messages, cursor}`；缺字段回落入参 cursor。 |
| `WechatAuth` | `startQr(opts)` / `waitForLogin(opts)` | 包装 vendor 两步登录；`botType` 缺省用 `DEFAULT_ILINK_BOT_TYPE`。 |

- 端口层唯一允许直接依赖 `api/types` 的文件是 `src/ports/types.ts`（集中 re-export）。
- adapter 只允许从 `src/ports/*` 取类型，不得把 vendor 类型直接暴露到端口签名。
- 冻结由 `tests/unit/adapters.test.ts` 的「端口冻结 / ACL 契约」用例回归（方法 arity 与
  `saveMedia` 3 参不泄漏）。

## 6. 变更检查清单

改动 vendor 边界（adapter / port）前后：

1. 跑全量校验：`bun install --frozen-lockfile && bun run typecheck && bun run test`。
2. 确认 vendor 零 diff：
   `git diff <base>...HEAD --stat -- api auth cdn media messaging util 'types/*.d.ts'`。
3. 确认端口冻结：新增 adapter 方法用 `fn.length` 回归；`SaveMediaFn` 不得回退到 5 参。
4. 确认没有新的直接 vendor import 泄漏到上层：
   `rg -n "from \"\\.\\./\\.\\./(api|auth|cdn|media|messaging|util)/" src --glob '!src/adapters/**' --glob '!src/ports/types.ts'`
   （应为空；`src/shared/file-logger.ts` 的 logger re-export 是已知例外）。
5. 确认反向 import 目标仍在：`rg -n "resolveStateDir" src/storage/state-dir.ts`。
6. 确认 ambient 声明仍在：`rg -n "openclaw/plugin-sdk/reply-runtime" types/openclaw-plugin-sdk.d.ts`。
7. 若触碰 `src/adapters/`，确保**只有注释新增**（无运行时逻辑改动）。
