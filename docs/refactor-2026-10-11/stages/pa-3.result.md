status: done
branch: refactor/pa-3-engine-use-ports
commits:
- 3ba22a580dd636fa8b1bb07f3fdea34b83b19b2d refactor(ports/adapters): outbound 薄化(ticket 参数) + inbound 游标回落
- 88a141e7dbb4a178a3186ecc8aef2fc40e532acd refactor(engine): 经 ports 访问微信边界
- 5c1670414e289d843104630be74f73efe9c08baa refactor(bridge): login 经 WechatAuth 端口
- 38270c10a36c9c97d57ba141a25ffa5cde73068c test(engine): mock 迁移到端口 fake
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（115 pass / 13 files / 0 fail / 292 expect calls）
test-changes: 基线 114 → 115（净 +1）。明细：
  - tests/engine/engine.test.ts 17 → 19（+2：D16 TTL 过期重取、sendTyping 报错含 "ticket" 清缓存后重取；
    原 adapter 侧的缓存语义迁到 TypingController 后在此补齐）
  - tests/engine/media-store.test.ts 11 → 12（+1：downloadAll 经端口 saveMedia 回调落盘并返回 { path }）
  - tests/engine/router.test.ts 9 → 9（仅 import 改 ports/types）
  - tests/unit/adapters.test.ts 21 → 19（-2：outbound 无缓存后合并旧缓存用例，改断直连/传入 ticket/冒泡）
  - 重命名 0，删除 0；既有断言语义保持
scope-check: 未越界。改动清单：
  - 修改 src/ports/outbound.ts（sendTyping(status, ticket)）
  - 修改 src/adapters/outbound.ts（删除 ticket 缓存；getTypingTicket 直连 getConfig；sendTyping 直连）
  - 修改 src/adapters/inbound.ts（cursor 缺字段回落 params.cursor）
  - 修改 src/engine/{polling,typing,sender,media-store,wechat,router}.ts
  - 修改 src/bridge/login.ts（经 createWechatAuth / 可注入 WechatAuth）
  - 修改 tests/setup/engine-harness.ts、tests/engine/{engine,media-store,router}.test.ts、tests/unit/adapters.test.ts
  - vendor 目录（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - src/bridge/{events,commands,tool-send-file}.ts diff vs dev 为空
acceptance:
  - [x] typecheck + test 全绿，115 ≥ 114，既有语义不降
  - [x] `rg "from \"\.\./\.\./(api|messaging|media|auth)/" src/engine src/bridge` 为空
  - [x] `rg "api/types" src/engine src/bridge` 为空（类型来自 ports/types）
  - [x] `rg "\.\./\.\./(api|messaging|media|auth)/|\.\./\.\./util/" src/engine src/bridge` 为空
  - [x] tests/setup/engine-harness.ts 无 mock.module（`rg "mock.module"` 退出码 1）
  - [x] WechatEngine 公共方法名/签名/返回未变（逐项比对 dev；仅构造函数新增可选 ports 注入）
  - [x] src/adapters/outbound.ts 无内部缓存；tests/unit/adapters.test.ts 相应更新并通过
  - [x] vendor 目录零 diff
  - [x] 提交原子（4 个逻辑提交），未 push，未改 base 分支
design:
  - 端口薄：`WechatOutbound.getTypingTicket()` 直连 getConfig 无缓存；`sendTyping(status, ticket)` 直连 vendor sendTyping；
    报错向上冒泡，由 TypingController 依 "ticket" 清缓存。
  - TypingController 保留 60s TTL + contextToken 绑定（`TypingDeps.getContextToken`）+ invalidateTicket() + "ticket" 清缓存。
  - PollingLoop 经 `deps.inbound.getUpdates({cursor,baseUrl,token,timeoutMs})` 并用 `{messages,cursor}`；
    generation/abort-race/重入守卫/needs_relogin 终态保留；缺字段回落由 adapter `?? params.cursor` 保证。
  - MediaStore 经 `media.download(item,{cdnBaseUrl,saveMedia,label})`；落盘目录/魔数/命名仍在本类；单项失败记录后继续。
  - WechatEngine 构造 adapters 并注入协作类，构造函数接受 `{ inbound?, outbound?, media? }`；
    createWechatEngine 接受 host/config/ports。
regressions:
  - D6/D7/D9/D13/D15/B5/ B6/C9 全在且通过；D14 断 outbound.sendFile 仅本地路径（无 display-name 字段）；
    D16 三条（contextToken 失效 / TTL 过期 / ticket 报错清缓存）；D16b unref 保留。
notes: |
  - tests/setup/engine-harness.ts 不再 mock api/messaging/media；改为导出
    inboundMock/outboundMock/mediaMock + resetPortMocks()，测试经
    createWechatEngine({inbound,outbound,media}) 注入。MessageItemType 直接取自 src/ports/types.js。
  - tests/unit/adapters.test.ts 仍 mock vendor 边界（adapter 单测的合理做法），符合验收（验收只要求
    engine-harness 不 mock vendor）。
  - login.ts 未显式传 botType，由 adapter 缺省为 DEFAULT_ILINK_BOT_TYPE，等价旧行为；bridge 测试
    （event-wiring D11/D20、turn-state）继续经既有 auth/login-qr mock 通过。
  - 单独运行 `bun test tests/bridge/` 存在基线即有的 `setLogLevel` mock 隔离报错；仓库约定入口
    `bun run test`（--isolate 全量）115 全绿，未受影响。
  - 未新增依赖；未 push；dev 为 HEAD 祖先。
