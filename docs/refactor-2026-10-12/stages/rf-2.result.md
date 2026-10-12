status: done
branch: refactor/rf-2-session
commits:
- dae9fc7d9e8d4b6e93e8d3bbf90620e1a34b487a feat(application): 新增 SessionService 收拢会话生命周期（含 SessionUi 适配）
- aa55943d96f0d153ba5a013f5d055fe759812b33 refactor(bridge): commands/events 委托 SessionService，删除 login.ts
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（155 pass / 17 files / 0 fail / 447 expect calls；基线 138 / 16 / 0，新增 17 例）
test-changes: 新增 17，重命名 0，删除 0
  - 新增 tests/application/session.test.ts（17 例，fake SessionChannel + fake auth + fake SessionUi + 真实 storage + 临时 agent dir）：
    start 有/无 token 两路 + 顺序 setConfig→notify→startPolling + startPolling 失败 Polling error；
    startFromStoredToken 有/无 token + 失败 logger.error("Polling error:", msg)；
    status 登录/未登录两路；（含 connectionState）stop stopPolling+文案；
    logout reset+删除账户（真实 storage 断言 token/index 已删）+未登录文案；
    login 成功（saveToken/upsertAccount 真实落盘、✅ 文案、setConfig→startPolling、摘要无明文 token D11）、
    login 启动轮询失败、login 未 connected、login startQr 无 url、login 外层异常；
    shutdown stopPolling+reset
  - 既有 tests/bridge/event-wiring.test.ts（D11/D20 等）断言零改动，仍全绿
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 7 个文件：
  - src/application/session.ts（新增，SessionService/SessionUi/SessionChannel）
  - src/bridge/session-ui.ts（新增，ctx/console/qrcode-terminal → SessionUi 适配）
  - src/bridge/commands.ts（只留 registerCommand+补全+子命令分发，操作委托 session）
  - src/bridge/events.ts（session_start → session.startFromStoredToken(ui)；session_shutdown → session.shutdown()；registerBridge 增加 session 参数）
  - src/index.ts（组合根 new SessionService({ channel, auth, logger })，注入 commands/bridge）
  - src/bridge/login.ts（删除，逻辑并入 SessionService）
  - tests/application/session.test.ts（新增）
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
    src/channel/**、src/ports/**、src/adapters/**、src/application/reply.ts、src/application/types.ts 零 diff；
    dev 为 HEAD 祖先（486ad98），未 push
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，155 pass / 17 files ≥ 138 / 16
  - [x] 新增 src/application/session.ts、src/bridge/session-ui.ts、tests/application/session.test.ts；src/bridge/login.ts 已删除
  - [x] `rg "startPolling|setConfig" src/bridge` 无命中（启动路径已收拢到 session.startPollingWith）
  - [x] `rg "getDefaultAccountToken|deleteAccountData|removeAccount|saveToken|upsertAccount" src/bridge` 无命中
  - [x] `rg "@earendil-works/pi-coding-agent|openclaw|api/|auth/|cdn/|media/|messaging/|util/|channel/channel" src/application` 无命中
  - [x] `rg "qrcode-terminal" src/application` 无命中（只存在于 src/bridge/session-ui.ts，与 console 一并收在该文件）
  - [x] 既有 tests/bridge/event-wiring.test.ts（D11/D20 等）与全量测试通过；未被削弱（零改动）
  - [x] `git diff dev...HEAD --stat` 仅限上述 7 个文件
  - [x] 提交原子（feat application 先行 → refactor bridge 接线），message 规范
behavior-contract:
  - [x] session_start：有 token → setConfig + startPolling（经私有 startPollingWith），失败 logger.error("Polling error:", err.message)；
        无 token 仅 logger.debug("session_start: no logged in account found")
  - [x] /wechat start：无 token → notify("WeChat: Not logged in. Use /wechat login first.", "error")；
        有 token → setConfig → notify("WeChat: Starting polling...", "info") → startPolling，
        失败 notify(`Polling error: ${err.message}`, "error")（顺序 setConfig→notify→startPolling 由测试断言）
  - [x] /wechat status：有 token → notify(`WeChat: Logged in\nUser ID: ${token.userId}\nConnection: ${channel.connectionState}`, "info")；
        否则 notify("WeChat: Not logged in", "info")
  - [x] /wechat stop：stopPolling → notify("WeChat: Stopped polling", "info")
  - [x] /wechat logout：channel.reset() → 有 token 则 deleteAccountData + removeAccount + notify("WeChat: Logged out successfully", "info")；
        否则 notify("WeChat: Not logged in", "info")
  - [x] /wechat login：startQr 无 qrcodeUrl → notify(`Failed to get QR code: ${startResult.message}`, "error")；
        有则 notify("请使用微信扫描二维码...", "info") → ui.showQr(url)（二维码渲染/浏览器兜底/失败提示逐字迁移到 session-ui）；
        waitForLogin connected → saveToken → upsertAccount → notify("✅ 与微信连接成功！", "info") → setConfig → startPolling
        （失败 notify(`启动轮询失败: ${err.message}`, "error")）→ 脱敏摘要（redactToken）经 ui.log 打印（含 "=== 登录成功 ===" 前后缀）；
        未 connected → notify(`登录失败: ${loginResult.message}`, "error")；
        外层异常 → logger.debug("performWechatLogin failed:", err) + notify(`登录异常: ${String(err)}`, "error")
  - [x] session_shutdown：stopPolling + reset
  - [x] 所有启动轮询路径经同一私有方法 startPollingWith：setConfig 与 startPolling 各只出现一处（session.ts 内唯一）
notes: |
  - 提交顺序：先 feat（session.ts + session-ui.ts + session.test.ts 纯新增，不改变运行时行为、测试全绿），
    再 refactor（commands/events/index 接线 + 删除 login.ts）；每个 commit 均可编译 / 测试通过。
  - 私有方法 startPollingWith(opts, onError, afterSetConfig?)：setConfig → (可选 afterSetConfig) → startPolling().catch(onError)，
    三种调用方差异（失败提示/日志、启动前文案位置）全部收敛在参数里，符合「启动轮询路径唯一入口」且保持原时序。
  - 依赖方向：src/application/session.ts 仅 import ../storage/state.js、../ports/auth.js（类型）、../shared/logger.js（类型）、
    ../shared/redact.js、../shared/types.js（类型）；qrcode-terminal / console 只在 src/bridge/session-ui.ts。
  - 行为不变性：所有 notify 文案、二维码展示（qrcode-terminal + 浏览器兜底行 + 失败分支）、登录成功摘要（脱敏）、
    存储调用集合（saveToken/upsertAccount/getDefaultAccountToken/deleteAccountData/removeAccount）、轮询错误提示均逐字保持；
    公共 API、持久化格式、redact 规则未改。D11（摘要无明文 token）与 D20（start 同时 setConfig）既有测试零改动通过。
  - 注：`bun run test` 为 `bun test --isolate`，全绿（155/17/0）。多文件不带 --isolate 直接 `bun test a b` 的
    mock.module 跨文件失效属既有 harness 行为（基线文件组合同样失败），与本阶段无关。
  - 未决项 / 需 human 决策：无。