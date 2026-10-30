# Verify Report: PA-2（adapters 薄包装 + 工具边界收口，不接入 engine）

- task: pa-2
- base-branch: `dev` @ `8b100e88f00ad5905c5c957ef75721428f8a2233`
- verified-branch: `refactor/pa-2-adapters` @ `5d4388eaf7ad20ef46f7d746c9ec0e02aeaac567`
- merge-base(dev, HEAD): `8b100e88f00ad5905c5c957ef75721428f8a2233`（dev 为祖先，线性 3 commit）
- mode: 只读（未修改代码、未提交、未 push；仅写本报告）
- verdict: **PASS**

## 结论

PA-2 全部 acceptance 通过。改动严格限定为 4 个 adapter 新增 + 2 个 shared 再导出边界
+ 3 处 import 收口 + `ports/types.ts` 纯增量 + 1 个新测试文件；vendor 目录、
`src/engine/*`、`src/bridge/{events,commands,tool-send-file}.ts` 全部零 diff。
测试 114 pass / 13 files / 0 fail，等于基线 93 + 本阶段新增 21，与 result 声明一致。

## 证据（命令输出）

### 1. install / typecheck / test 全绿
```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
Checked 131 installs across 139 packages (no changes) [3.00ms]   # exit 0

$ bun run typecheck
$ tsc --noEmit                                                   # exit 0，无输出

$ bun run test
...
 114 pass
 0 fail
 290 expect() calls
Ran 114 tests across 13 files. [703.00ms]                        # exit 0
```
- ✅ 三个命令全部成功（exit 0）。

### 2. 测试数 ≥ 基线，且与 result 的 test-changes 一致
- 基线：93 pass / 12 files / 0 fail
- 实测：114 pass / 13 files / 0 fail
- 新增文件 `tests/unit/adapters.test.ts`：`rg -c "^test\("` = **21**
- 93 + 21 = 114，文件 12 + 1 = 13。全仓库 `rg -c "^test\(" tests -g '*.test.ts'` 合计 = 114。
- ✅ 用例数 ≥ 基线 + 本阶段新增；无重命名/删除（`git diff dev...HEAD --name-status -- tests`
  仅 `A tests/unit/adapters.test.ts`），与 result 声明 `新增 21，重命名 0，删除 0` 一致。

### 3. `git diff dev...HEAD --stat` 未越界
```
 src/adapters/auth.ts        |  61 ++++++
 src/adapters/inbound.ts     |  33 +++
 src/adapters/media.ts       |  56 +++++
 src/adapters/outbound.ts    | 174 ++++++++++++++++
 src/bridge/login.ts         |   2 +-
 src/ports/types.ts          |  11 +
 src/shared/file-logger.ts   |   8 +
 src/shared/logger.ts        |   2 +-
 src/shared/redact.ts        |   8 +
 src/storage/state.ts        |   2 +-
 tests/unit/adapters.test.ts | 476 ++++++++++++++++++++++++++++++++++++++++++++
 11 files changed, 830 insertions(+), 3 deletions(-)
```
- ✅ 仅任务 scope 内文件；package.json / bun.lock / tsconfig 零改动（无新增依赖）。

### 4. vendor 目录 diff 必须为空
```
$ for d in api auth cdn media messaging util types; do git diff dev...HEAD --stat -- "$d"; done
（7 个目录全部无输出）
```
- ✅ vendor（api/ auth/ cdn/ media/ messaging/ util/）及 `types/` 零改动。

### 5. engine / bridge 行为逻辑未改
```
$ git diff dev...HEAD -- src/engine
（空）

$ git diff dev...HEAD -- src/bridge/events.ts src/bridge/commands.ts src/bridge/tool-send-file.ts
（空）

$ git diff dev...HEAD -- src/bridge
（仅 src/bridge/login.ts 一行 import：../../util/redact.js → ../shared/redact.js）
```
- ✅ `src/engine/*` 字节级零改动；`events.ts/commands.ts/tool-send-file.ts` 零改动；
  `bridge/login.ts` 仅 import 路径变化，逻辑未动。

### 6. `rg "util/(redact|logger)" src` 仅命中两个 re-export 边界
```
$ rg -n "util/(redact|logger)" src
src/shared/file-logger.ts:4: * `util/logger.ts` 被 vendor 内部（api/auth/cdn/media/messaging）大量引用，
src/shared/file-logger.ts:8:export { logger, setLogLevel } from "../../util/logger.js";
src/shared/redact.ts:4: * `util/redact.ts` 被 vendor 内部（api/auth/cdn/media/messaging）大量引用，
src/shared/redact.ts:8:export { redactToken, redactBody, redactUrl } from "../../util/redact.js";
```
- ✅ 仅 `src/shared/redact.ts` 与 `src/shared/file-logger.ts`（含注释）。自写代码无残留直连。
  `rg -n "from \"[^\"]*util/" src` 只余这两行的 `export ... from`。

### 7. 两个边界为薄再导出（无逻辑复制）
- `src/shared/redact.ts`：仅注释 + `export { redactToken, redactBody, redactUrl } from "../../util/redact.js";`
- `src/shared/file-logger.ts`：仅注释 + `export { logger, setLogLevel } from "../../util/logger.js";`
- ✅ 无任何函数体/常量复制/副作用。
- 自写代码收口确认：`src/bridge/login.ts` → `../shared/redact.js`；
  `src/storage/state.ts` → `../shared/file-logger.js`；`src/shared/logger.ts` → `./redact.js`。

### 8. 4 个 adapter 正确实现 ports（逐条核对）
- **inbound** `src/adapters/inbound.ts`：调用 `api/api.getUpdates({baseUrl, token,
  get_updates_buf: cursor, timeoutMs})`，映射 `{ messages: resp.msgs ?? [], cursor:
  resp.get_updates_buf ?? "" }`。✅ `{msgs,get_updates_buf}`→`{messages,cursor}`。
- **outbound** `src/adapters/outbound.ts`：
  - `sendText` → `sendMessageWeixin({to: userId, text, opts:{baseUrl,token,contextToken}})`；凭证缺失抛
    `"Single user not initialized"`（与 `engine/sender.ts` 一致）。✅
  - `sendFile` → `sendWeixinMediaFile({filePath, to, text:"", opts, cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c"})`。✅
  - `getTypingTicket`：`TYPING_TICKET_CACHE_TTL_MS = 60_000`；缓存命中条件
    `contextToken === creds.contextToken && Date.now() < expiresAt`；`getConfig` 成功且
    `ret===0 && typing_ticket` 才写入缓存；凭证缺失/失败返回 null；`getConfig` catch 中
    `errMsg.includes("ticket")` 时清缓存。✅ 60s TTL + contextToken 绑定 + "ticket" 清缓存。
  - `sendTyping(status)`：取缓存 ticket 后 `sendTyping({baseUrl, token, body:{ilink_user_id,
    typing_ticket, status}})`；无 ticket 记录错误并 return（不抛）；catch 中 "ticket" 清缓存。✅
  - 凭证来自构造注入 `getCredentials()`，端口方法不带凭证参数。✅
- **media** `src/adapters/media.ts`：`saveMedia: (buffer, contentType, _subdir, _maxBytes,
  originalFilename) => saveMedia(buffer, contentType, originalFilename)` 把端口 3 参适配为 vendor 5 参；
  按 `decryptedPicPath ?? decryptedVoicePath ?? decryptedFilePath ?? decryptedVideoPath`
  取首个非空 → `{path}`，否则 `null`；`label` 缺省 `"media"`；`log/errLog` 构造注入默认 no-op；
  不做目录/命名/魔数逻辑。✅
- **auth** `src/adapters/auth.ts`：`startQr` 透传 `apiBaseUrl/accountId/botType(??
  DEFAULT_ILINK_BOT_TYPE)/force/timeoutMs/verbose`，返回 `qrcodeUrl/message/sessionKey`；
  `waitForLogin` 透传并映射 `connected/message/botToken/accountId/baseUrl/userId`。✅ 字段对齐端口。
- 覆盖检查：`tests/unit/adapters.test.ts` 21 例覆盖 inbound 映射（含缺字段回落）、outbound
  发送/凭证缺失/缓存命中/TTL/contextToken 失效/失败返回 null/报错清缓存/无 ticket 不抛、
  media 3→5 回调适配与路径优先挑选（Pic>Voice>File>Video）/无路径返回 null/label 缺省、
  auth 字段映射（含缺省/显式）。✅

### 9. adapter 未被 engine/bridge 接入
```
$ rg -n "adapters" src/engine src/bridge
（无输出，exit 1）
$ rg -n "src/adapters" src/engine src/bridge
（无输出，exit 1）
$ rg -n "src/adapters|adapters/(inbound|outbound|media|auth)" src --glob '!src/adapters/**'
（无输出，exit 1）
$ rg -n "adapter" src/index.ts
（无输出，exit 1）
```
- ✅ 组合根/引擎/桥接均未引用 adapter（registry 未变）。

### 10. `src/ports/types.ts` 仅增量新增 `WechatCredentials`
```
+export interface WechatCredentials {
+  baseUrl: string;
+  token: string;
+  userId: string;
+  contextToken: string;
+}
```
- ✅ diff 仅 11 行纯新增（含注释），既有 `WeixinMessage`/`MessageItem`/`MessageItemType`
  转发与其它接口均未改。

### 11. 关键回归语义仍被断言覆盖（未退化）
- 既有测试文件在本分支 **diff 为空**（`tests` 下仅新增 adapters.test.ts），因此覆盖度不降。
- D11 脱敏：`tests/bridge/event-wiring.test.ts`「D11 目标：日志中不应出现明文 botToken」仍通过。
- D14 发送：`tests/engine/engine.test.ts`「基线：sendFileToUser 以本地文件名提交底层发送」仍通过。
- D16 typing：`tests/engine/engine.test.ts`「D16 contextToken 变化后应重新获取 typing ticket」、
  「D16b typing keepalive interval 应调用 unref」仍通过。
- redact 规则未变：`util/redact.ts` 零改动，`src/shared/redact.ts` 纯再导出。

### 12. 提交原子性与 message 规范
```
5d56132 refactor(shared): 建立 redact/file-logger 再导出边界并收口自写 import
f039c37 feat(adapters): 新增 4 个微信侧 adapter 薄包装
5d4388e test(adapters): 新增 adapter 基线用例
```
- ✅ 3 个逻辑独立 commit：边界收口 / adapter 实现+端口增量 / 测试基线；无混合改动；
  未 push、未改 base 分支（dev 为 HEAD 祖先）。
- ✅ 工作树干净（`git status --porcelain` 空），验证过程未产生改动。

## 备注（非阻塞）
- result 记录的未决项（inbound 缺 `get_updates_buf` 时回落 `""`，而旧 `PollingLoop` 语义为
  回落旧 cursor）在本阶段不构成回归：adapter 未接入 engine，运行时行为不变；S3 接入时
  需在 channel/engine 侧决定是否保留旧 cursor。
- outbound `getTypingTicket` 在 `getConfig` 抛错含 "ticket" 时清缓存，为任务书显式要求
  （`engine/typing.ts` 原实现无此分支），因未接入而不影响现有行为，S3 接入时留意差异。

## 判定
**PASS** — 全部 acceptance 与 verify 专项检查通过，可执行 `git merge --ff-only refactor/pa-2-adapters`。
