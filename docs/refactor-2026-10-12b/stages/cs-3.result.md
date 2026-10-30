status: done
branch: refactor/cs-3-remove-slash-command
commits:
- 9b933a3e0d48abf7ea1f2fdea2a61c31b7943c31 refactor(channel): 移除自研层微信入站 slash 命令拦截
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（184 pass / 21 files / 0 fail / 528 expect calls；基线 189 / 21 / 0；typecheck 零错误）
test-changes: 修改 2 文件（新增 1 用例、删除 6 失效用例、3 处对象相等断言随字段收敛调整），无断言削弱
  - tests/channel/inbound-parser.test.ts（修改）
    - 对象相等断言 4 字段 → 3 字段（`isCommand` 字段已删除）：
      1. "item_list 缺失 → 三字段全空"：`toEqual({ text:"", hasText:false, hasMedia:false })`（原含 isCommand）；
      2. "item_list 为空数组 → 三字段全空"：同上；
      3. "纯媒体（IMAGE）→ hasMedia=true、hasText=false、text=''"：`toEqual({ text:"", hasText:false, hasMedia:true })`（原含 isCommand）。
    - 删除 `isCommand` 单字段断言、保留其余断言（覆盖不变）：
      4. "多个 TEXT → 以 \n 精确拼接"：删除 `expect(parsed.isCommand).toBe(false)`；仍断言 `text === "a\nb\nc"` 与 `hasText === true`；
      5. "空白文本 → text 保留原文、hasText=false"：删除 `expect(parsed.isCommand).toBe(false)`；仍断言 `text === "   "` 与 `hasText === false`。
    - 删除 6 个仅断言 `isCommand` 的用例（导向：失效——`isCommand`/slash 拦截功能整体移除）：
      6. "`/help` → isCommand=true（原 D15 基线）"；
      7. "普通文本 `hi` → isCommand=false（原 D15 基线）"；
      8. "`  /help  ` 前后空白 → isCommand=true"；
      9. "`/unknown` 未知命令 → isCommand=true"；
      10. "slash 出现在第 2 个 TEXT 项 → isCommand=true（原 D15 目标）"；
      11. "第 2 个 TEXT 项为普通文本 → isCommand=false"。
      · 说明：这 6 例断言的对象是已被删除的解析字段/行为，无法迁移。其业务意图（slash 不再被特殊对待）
        由新增的 channel.test.ts 行为变更回归用例覆盖，故覆盖面无净缩小（属本阶段声明的有意行为变更）。
    - 覆盖清单仍满足 task test-plan：空/missing、单/多 TEXT 拼接、空串保留、空白 hasText=false、纯媒体、文本+媒体、type 未定义。
    - 断言强度：全部保留 `toEqual` 精确对象 / `toBe` 精确值；未使用弱断言，未删 expect 以外的强度削弱。
  - tests/channel/channel.test.ts（修改）
    - 新增 1 用例："CS-3 行为变更：'/' 开头的消息不再被拦截，作为普通消息交给 AI"
      · 经 `Channel.handleMessage(textMessage("/foo"), opts)` 送入：
        断言 `pi.calls.appendEntry[0][0] === "wechat_meta"`、`sendUserMessage.length === 1`、
        `sendUserMessage[0][0] === "/foo"`、`sendUserMessage[0][1]` `toEqual({ deliverAs: "followUp" })`
        （证明未发生 slash 早退、完整走完 AI 路径）；并断言 `outboundMock.sendText` 未被调用
        （区别于媒体 ack / 旧 `/help` 回显）。
    - 更新文件头覆盖注释：`D15 slash 判定` → `CS-3 slash 拦截移除后的 "/foo" 行为回归`。
    - 原 D15 注释块改为 CS-3 说明块（记录 D15 与 isCommand 断言失效、去向见本 ledger）。
    - 其余 contextToken / 队列 / 媒体 / F6 用例零改动。
  - 目的地汇总：删除 6 例（全部「失效」，功能移除导致断言对象不存在）；无「无去向」删除；新增 1 例覆盖新行为；无断言被削弱。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 5 个文件：
  - README.md（修改）
  - src/channel/channel.ts（修改）
  - src/channel/inbound-parser.ts（修改）
  - tests/channel/channel.test.ts、tests/channel/inbound-parser.test.ts（修改）
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、src/storage/**、src/index.ts、
  src/channel/{router,polling,queue,typing,sender,media-store,state,request-id}.ts 零 diff；
  dev（09b770e）为 HEAD 祖先；未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误
        （184 pass / 21 files / 0 fail / 528 expect calls；低于 baseline 189 属预期：净删 5 例）
  - [x] `src/channel/channel.ts`：无 `parseInbound` / `handleSlashCommand` / `isCommand`（`rg` 无命中）
  - [x] `src/channel/inbound-parser.ts`：`ParsedInbound` 仅含 `{ text, hasText, hasMedia }`（`rg "isCommand" src` 无命中）
  - [x] `README.md` 不再声称“以 `/` 开头的消息被拦截/仅 `/help` 有响应”；改为符合新行为的描述
  - [x] 新增行为变更回归用例：`"/foo"` → `host.sendUserMessage` 被调用、`outbound.sendText` 未被调用
  - [x] 其它路径行为与契约不变；`Channel` 公共 API（除内部私有方法）与端口签名不变
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{channel,inbound-parser}.ts`、`tests/channel/**`、`README.md`
  - [x] result 的 test-changes ledger 完整，无削弱断言；含「行为变更」说明
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] `handleMessage` 顺序不变（去除 slash 分支后）：生成 requestId → contextToken 更新（`typing.invalidateTicket()` + 条件持久化）→ `triggerAi`
  - [x] 非 slash 文本 / 纯媒体 / contextToken 更新与持久化 / typing 失效 / 队列 / 防重 / 排空路径不变（既有用例全绿）
  - [x] `parseInbound` 其余语义不变：`text` 仅 TEXT 项以 `"\n"` 拼接（不 trim、不过滤空串）；`hasText` 存在 TEXT 且 trim 为真；`hasMedia` 存在 `type !== TEXT`
  - [x] `MessageRouter` 契约不变：仍使用 `parseInbound` 的 `text/hasMedia/hasText`（纯媒体 ack + 后台入队；文本 `appendEntry("wechat_meta")` + `sendUserMessage`）
  - [x] `Channel` 公共 API、文案、持久化、端口签名不变（仅删除私有 `handleSlashCommand`）
  - [x] `Channel.sendText` 未删除（见 notes；cs-7 再清理公开面）
行为变更:
  - 有意变更：自研 channel 不再拦截以 `/` 开头的微信入站消息。此前 `parseInbound.isCommand === true` 会早退（仅 `/help` 回 “可用命令: /help”，其它 `/xxx` 静默吞掉）；现在这类消息与普通消息一样走 `contextToken 更新 → triggerAi → AI`，`/foo` 会触发 `host.sendUserMessage(content="/foo", { deliverAs:"followUp" })` 且不发送文本回执。
  - 不变：pi 的真实命令仍不会被微信触发（`sendUserMessage` 绕过 slash 路由，by design）；README 已同步说明。
  - 范围声明：仅移除自研层拦截。vendor 层若也存在拦截导致端到端行为不变，属冻结的 vendor 部分，不在本阶段范围（非阻塞观察，未改动）。
notes: |
  - 单一批量原子提交：本阶段为一个逻辑（移除自研层入站 slash 拦截/回显职责），
    prod 修改 + 测试调整 + README 同步放入同一 commit，避免中间不可编译/文档不一致状态。
  - `Channel.sendText`（`src/channel/channel.ts`）**未删除**：移除 slash 后它在 `src/` 已无调用方
    （`rg "\.sendText\(" src tests` 仅剩 `sender.ts` 内部调用，且那是 `MessageSender.sendText`，非 `Channel.sendText`），
    但按任务书 forbidden 要求保留公开面，清理留待 cs-7。
  - `handleMessage` 的 `opts` 参数仍被 `triggerAi` 使用，签名不变；`WechatApiOpts` import 保持。
  - README 两处更新：①「已知限制」blockquote 改为“自研层不再拦截，`/` 开头消息交给 LLM，但仍不触发 pi 真实命令”；
    ②「常见现象」表 `微信命令无反应` 行调整为 `微信 /命令 不执行 pi 命令`，并注明消息会照常交给 LLM。
  - 未决项 / 需 human 决策：无。
