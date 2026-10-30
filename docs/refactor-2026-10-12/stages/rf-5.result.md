status: done
branch: refactor/rf-5-acl
commits:
- 643596e2c55bfaa48b32181aa5b049042be1f041 refactor(adapters): 明确 ACL 边界、vendor 约束文档与端口冻结

tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （163 pass / 18 files / 0 fail / 472 expect calls；基线 160 / 18 / 0，新增 3 例；typecheck 零错误）

test-changes: 新增 3，修改 0，删除 0
  - 新增 tests/unit/adapters.test.ts「端口冻结：WechatOutbound 方法参数面（sendFile 不得加 to）」：
    sendText.length===1、sendFile.length===1、sendTyping.length===2、getTypingTicket.length===0。
  - 新增「端口冻结：WechatMedia / WechatInbound / WechatAuth 方法参数面」：
    media.download.length===2、inbound.getUpdates.length===1、auth.startQr.length===1、auth.waitForLogin.length===1。
  - 新增「ACL 契约：vendor 5 参 saveMedia → 端口仅收到 3 参，subdir/maxBytes 不泄漏」：
    复用文件已有 vendor mock 与动态 import；vendor 以 5 参
    `(Buffer.from("acl"), "image/png", "inbound", 100, "orig.png")` 调用回调，
    断言端口 `saveMedia.mock.calls[0].length===3` 且值正确（buffer/contentType/originalFilename），
    subdir/maxBytes 不泄漏。
  - 既有 PA-2 用例零改动、断言未削弱，全部通过。

scope-check: 未越界。`git diff dev...HEAD --stat` 仅 6 个文件：
  - src/adapters/{inbound,outbound,media,auth}.ts：各 +11~13 行，**全部为顶部 ACL 注释新增**；
    `git diff` 中删除行 0、新增非注释代码行 0（grep 过滤 `*`/`/*`/`//` 后计数为 0）。
  - docs/vendor-constraints.md：+135（新增，含 6 个章节）。
  - tests/unit/adapters.test.ts：+57（新增端口冻结 / ACL 契约 3 例）。
  核对为空的项：
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖。
  - src/ports/**、src/channel/**、src/bridge/**、src/application/**、src/storage/**、src/shared/** 零 diff。
  - 未 push；dev 未改（dev = 1c9dd88 仍为 HEAD 祖先）；当前分支 refactor/rf-5-acl。

acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，163 pass / 18 files ≥ 160；typecheck 零错误
  - [x] docs/vendor-constraints.md 存在且含 6 个章节：
        1 目的与维护规则 / 2 所有权与目录 / 3 已知不可动耦合（3.1~3.6 逐条：位置/性质/影响/应对）/
        4 低使用 / 死代码 / 5 端口冻结与责任边界 / 6 变更检查清单
  - [x] 4 个 adapter 顶部有 ACL 注释；`git diff dev...HEAD -- src/adapters` 非注释代码行零改动（删除行 0）
  - [x] tests/unit/adapters.test.ts 新增端口冻结 / ACL 契约用例并通过（新增 3 例）
  - [x] `git diff dev...HEAD --stat` 仅限 src/adapters/*.ts、docs/vendor-constraints.md、tests/unit/adapters.test.ts
  - [x] 提交原子（ACL 注释 + 约束文档 + 冻结测试同属一个逻辑，单 commit；可编译 / 测试通过），message 规范

port-freeze:
  - [x] `WechatOutbound`：sendText(text) / sendFile(localPath) / sendTyping(status, ticket) / getTypingTicket()；未给 sendFile 加 `to`
  - [x] `WechatMedia.download(item, deps)`；`SaveMediaFn = (buffer, contentType?, originalFilename?)` 未改
  - [x] vendor `subdir="inbound"` / `maxBytes=100MB` 由 adapter 有意丢弃；落盘策略仍在 src/channel/media-store.ts
  - [x] `WechatInbound.getUpdates(params)`；`WechatAuth.startQr(opts)` / `waitForLogin(opts)` 未改
  - [x] src/ports/** 零 diff，端口签名冻结

acl-comments:
  - [x] inbound.ts：唯一接触 vendor `api/api.getUpdates`；`{msgs,get_updates_buf}` → `{messages,cursor}`；缺字段回落入参 cursor
  - [x] outbound.ts：唯一接触 vendor 发送接口；凭证来自注入 provider；固定 CDN 基址在 adapter 内；ticket 不缓存
  - [x] media.ts：唯一接触 `media/media-download`；vendor 5 参 saveMedia → 端口 3 参；subdir/maxBytes 有意丢弃；
        返回按 Pic > Voice > File > Video 取第一个非空
  - [x] auth.ts：唯一接触 `auth/login-qr`；login-qr 两步包装；`botType` 缺省用 `DEFAULT_ILINK_BOT_TYPE`
  - [x] 四个文件均声明「不得把 vendor 类型/路径/全局状态泄漏回上层」

notes: |
  - 适配策略：ACL 说明以新的 `/** … */` 块**前置**在各 adapter 原有文件头之上，纯新增，不改任何 import / 函数 / 类型；
    因此 `git diff` 删除行为 0，新增行全部落在块注释内。
  - docs/vendor-constraints.md 记录 6 条已知耦合：`messaging/inbound.ts` 反向 import
    `src/storage/state-dir.js`（type-only，运行时常不加载）、`messaging/send.ts` 私有类型
    `openclaw/plugin-sdk/reply-runtime`（靠 types/openclaw-plugin-sdk.d.ts ambient）、
    vendor 内部 10 处直接使用 `util/logger.ts`（写 `$TMPDIR/openclaw-*.log`、读 `OPENCLAW_LOG_LEVEL`）、
    `getUpdates` 无 AbortSignal 且 35s 常量与 src/channel/polling.ts 重复、context token store 写旧路径
    `~/.pi/agent/.../openclaw-weixin/...`（当前未调用）、`saveMedia` 5 参。
  - 低使用 / 死代码：`messaging/markdown-filter.ts`（send.ts 再导出 `StreamingMarkdownFilter` 但无人消费）、
    `messaging/inbound.ts`（仅 media/media-download.ts 以 import type 引用）；均属 vendor，删除前需评估调用面。
  - 未决项 / 需 human 决策：无。
