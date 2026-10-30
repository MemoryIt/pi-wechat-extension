# PA-5 验证报告

- verdict: **PASS**
- base-branch: `refactor/pa-5-channel-split`
- base(dev): `ec14f4120e05cbf73a60ef31e83a9c5af094f5b3`
- HEAD: `8c7eb7f9883b13bf62f58a9cdf5042301977bd86`
- merge-base(dev, HEAD) == dev 节点（`ec14f41`），4 个原子提交，工作树 clean
- verifier: 只读；未修改代码、未提交、未 push

---

## 1. 构建 / 测试（check 1 & 2）

命令（一次链式）：
```
bun install --frozen-lockfile && bun run typecheck && bun run test
```
结果 `CHAIN_EXIT=0`：

| 项 | 结果 |
| --- | --- |
| install | `Checked 131 installs across 139 packages (no changes)` |
| typecheck | `tsc --noEmit` 无输出，exit 0 |
| test | **126 pass / 0 fail / 362 expect() calls / Ran 126 tests across 15 files** |

基线核对：用 `git archive dev` 到 `/tmp/pa5-baseline` 实跑 `bun test --isolate`：
```
121 pass / 0 fail / 330 expect() calls / Ran 121 tests across 14 files
```
→ 净增 **+5 用例 / +1 文件**，与 `pa-5.result.md` 的 test-changes 完全一致（≥ 基线 121）。

逐文件 test 数比对（baseline vs HEAD，全部 OK，无既有用例丢失）：
```
tests/bridge/event-wiring.test.ts  8=8
tests/bridge/meta.test.ts          2=2
tests/bridge/turn-state.test.ts    6=6
tests/bridge/turn.test.ts          8=8
tests/engine/engine.test.ts       21=21
tests/engine/media-store.test.ts  12=12
tests/engine/queue.test.ts         9=9
tests/engine/router.test.ts        9=9
tests/unit/adapters.test.ts       19=19
tests/unit/channel-state.test.ts   4=4
tests/unit/config.test.ts          5=5
tests/unit/dependencies.test.ts    2=2
tests/unit/logger.test.ts         10=10
tests/unit/storage.test.ts         6=6
tests/integration/channel-flow.test.ts 新增 5
```

## 2. 边界 / 越界（check 3）

`git diff dev...HEAD --name-status`（全部改动）：
```
A  src/channel/channel.ts
R100 src/engine/media-store.ts -> src/channel/media-store.ts
R100 src/engine/polling.ts     -> src/channel/polling.ts
R100 src/engine/queue.ts       -> src/channel/queue.ts
R098 src/engine/router.ts      -> src/channel/router.ts
R100 src/engine/sender.ts      -> src/channel/sender.ts
R100 src/engine/typing.ts      -> src/channel/typing.ts
M  src/engine/wechat.ts
M  tests/engine/engine.test.ts
M  tests/engine/media-store.test.ts
M  tests/engine/queue.test.ts
M  tests/engine/router.test.ts
A  tests/integration/channel-flow.test.ts
```
- **vendor 目录 diff 为空**：`api/ auth/ cdn/ media/ messaging/ util/ types/` 均 `clean`。
- **`src/bridge/*` diff 为空**、`src/index.ts` 为空、`package.json`/`bun.lock`/`tsconfig.json` 均为空。
- 未新增依赖、未越界。

## 3. 目录结构 / 依赖方向（check 5 & 6）

- `src/channel/` = `channel.ts, media-store.ts, polling.ts, queue.ts, router.ts, sender.ts, state.ts, typing.ts`（channel.ts + 原协作类）。
- `src/engine/` 仅剩 `wechat.ts`。
- `rg 'from "\.\./engine' src/channel` → **exit 1（无匹配）**。channel 内出现的 “engine” 仅为注释/日志字符串，无 import。
- `channel/router.ts` 宿主类型已改为 `../ports/pi-host.js` 的 `PiHost`（见第 6 节 diff）。

## 4. 协作类“纯移动”核验（check 9）

逐文件对 `dev:src/engine/*.ts` 与 `HEAD:src/channel/*.ts` 做 blob 文本 diff：

| 文件 | 结果 |
| --- | --- |
| polling | IDENTICAL |
| queue | IDENTICAL |
| media-store | IDENTICAL |
| sender | IDENTICAL |
| typing | IDENTICAL |
| router | 仅 2 行：`import type { WechatHost } from "./wechat.js"` → `PiHost from "../ports/pi-host.js"`；`getHost(): WechatHost\|null` → `PiHost\|null` |

→ 纯移动，无逻辑漂移。

## 5. WechatEngine 公共 API / 薄门面（check 7 & 8）

`src/engine/wechat.ts` diff 中：
- 删除原编排实现（构造 wiring、initSingleUser、handleMessage、triggerAi、reset、generateRequestId、getCredentials、getCurrentOpts、extractText、isSlashCommand、handleSlashCommand 等），改为持有 `private channel = new Channel({ ports })` 并逐成员委托。
- 公共成员逐一对齐（dev → HEAD 全部存在，签名一致）：
  `setHost / setNotifier / setConfig / configure / connectionState / getTerminalProcessing / setTerminalProcessing / initSingleUser / stopPolling / startPolling / handleMessage / triggerAi / onAiDone / getTypingTicket / sendTypingStatus / startTypingKeepalive / stopTypingKeepalive / sendTextMessage / sendFileToUser / sendMessageWithRetry / getCurrentRequestId / isRequestProcessed / markRequestProcessed / cleanupProcessedRequests / reset`。
- 导出不变：`ConnectionState`(re-export from `../channel/polling.js`)、`WechatHost=PiHost`、`WechatConfig`、`WechatEnginePorts`、`WechatEngineDeps`、`setPi`、`setConfig`、`WechatEngine`、`createWechatEngine`、`engine`。
- 抽查下沉：`handleMessage`/`triggerAi`/`initSession`/`reset` 的编排体已在 `Channel`，engine 内已无对应逻辑。
- Channel 构造 wiring 与旧 engine 逐段一致（adapter 缺省构造、MediaStore、TypingController、MessageSender、MessageRouter、PollingLoop deps 全部保留）。

## 6. 集成测试真穿 Channel（check 9 相关）

`tests/integration/channel-flow.test.ts`（5 个用例，全绿）：
- **真 Channel**：`new Channel({ host, config, ports })`（动态 import `src/channel/channel.js`）；未 stub 任何 channel 内部方法（仅读取 `channel.queue/state` 做断言）。
- **假 PiHost 探针** `createFakeHost()`，通过 `ChannelDeps.host` 注入。
- **假端口** `makePorts()`：`inbound.getUpdates / outbound.sendText|sendFile|sendTyping|getTypingTicket / media.download` 注入。
- **真实 storage**（临时 `agentDir`，`seedSingleUser()` 真写 token/account/contextToken）。
- 覆盖：入站文本（`wechat_meta` + `sendUserMessage followUp` + `onAiDone` 排空）、入站媒体（ack + 后台 `media.download` + `wechat_media` history）、typing（`sendTyping(1,ticket)` / stop）、出站（`sendReply`→`sendText`、`sendFile`→`sendFile`）、reset（清凭证、保留 config/host/notifier）。
- 测试文件内**无 `mock.module`**；仅经 `installBaseMocks()` 固定 `getAgentDir`（pi SDK）、typebox、`util/logger.js`（基础设施，非微信边界），微信 `api/messaging/media` vendor 全部真加载、经端口注入绕行。**未 mock 任何微信输出/媒体 vendor 边界。**

## 7. 关键回归语义（check 11）

`tests/engine/engine.test.ts` 保留全部断言，仅私有观测点改走 `engine.channel.*`（`state/queue/router/generateRequestId/isSlashCommand`），断言语义未变。标签均在：
`D3, D6, D7, D9, D13, D14, D15, D16(x3), D16b, B4, B5(x2), B6, C9` 全部存在且随套件通过。

## 8. 提交（check 12）

```
aecc4b5 refactor(channel): 移动协作类到 channel/ 并更新 import
69b67c1 refactor(channel): 新增 Channel 粗粒度编排器
4f18d67 refactor(engine): WechatEngine 退化为委托 Channel 的薄门面
8c7eb7f test(channel): 新增通道集成测试
```
每个提交只含对应逻辑（commit 1：纯 rename + import；commit 2：仅 channel.ts；commit 3：engine.ts + engine.test 观测点；commit 4：仅集成测试）。均 conventional commit，原子；未 push；未改 base。

---

## 备注（非阻塞）

1. `WechatEngine.get connectionState` 省略了显式返回类型标注，推导类型仍为 `ConnectionState`（Channel getter 显式标注，tsc 通过），公共 API 类型不变。
2. `Channel.reset()` 的 debug 日志由 `"Engine state reset"` 改为 `"Channel state reset"`（仅调试日志文本，不影响行为语义）。
3. `docs/ARCHITECTURE.md`、`tests/README.md`、`src/adapters/outbound.ts` 注释/文档仍引用 `engine/*` 旧路径；result 已声明文档同步留给 S8，且非本阶段 scope，不影响运行。
4. 集成测试经由 `installBaseMocks()`（全仓测试基线设施）mock 了 `util/logger.js`（属 vendor 目录之一）以及 pi SDK/typebox；这是既有约定且不替换任何微信边界行为，任务意图“走端口注入、不 mock 微信 vendor 边界”满足。

## 命令清单

```
bun install --frozen-lockfile && bun run typecheck && bun run test   # exit 0, 126/15/0
git archive dev | tar -x -C /tmp/pa5-baseline && (cd /tmp/pa5-baseline && bun test --isolate)  # 121/14/0
git diff dev...HEAD --stat / --name-status
git diff dev...HEAD -- api auth cdn media messaging util types      # 空
git diff dev...HEAD -- src/bridge src/index.ts                      # 空
diff <(git show dev:src/engine/POLLING) <(git show HEAD:src/channel/POLLING)  # 5 个 IDENTICAL，router 仅 2 行
rg 'from "\.\./engine' src/channel                                  # 无匹配
ls src/engine                                                       # 仅 wechat.ts
```
