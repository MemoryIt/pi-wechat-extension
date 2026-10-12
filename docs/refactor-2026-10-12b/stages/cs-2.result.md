status: done
branch: refactor/cs-2-inbound-parser
commits:
- 414c41c0730df875b1fbbae514c1b2b01ae1802f refactor(channel): 抽取 inbound-parser 统一入站消息解析
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（189 pass / 21 files / 0 fail / 531 expect calls；基线 176 / 20 / 0；typecheck 零错误）
test-changes: 新增 1 文件（15 用例），修改 1 文件（迁移 2 用例，无删除/无削弱），重命名 0
  - tests/channel/inbound-parser.test.ts（新增）
    - 覆盖 cs-2.md test-plan 全部条目：
      1. item_list 缺失 → 四字段全空；
      2. item_list 空数组 → 四字段全空；
      3. 单个 TEXT → text 原文；
      4. 多个 TEXT → text 精确 `a\nb\nc`（不 trim、不过滤空串）；
      5. 多 TEXT 含空串 → 保留空串 `a\n\nb`；
      6. 空白文本 `"   "` → text 保留原文、hasText=false；
      7. `"/help"` → isCommand=true（原 D15 基线，迁移）；
      8. `"hi"` → isCommand=false（原 D15 基线，迁移）；
      9. `"  /help  "` → isCommand=true；
      10. `"/unknown"` → isCommand=true；
      11. slash 出现在第 2 个 TEXT 项（前置 IMAGE）→ isCommand=true（原 D15 目标，迁移）；
      12. 第 2 个 TEXT 项为普通文本 → isCommand=false；
      13. 纯媒体 IMAGE → hasMedia=true、hasText=false、text=""、isCommand=false；
      14. 文本 + 媒体混合 → hasMedia=true、hasText=true、text="hi"；
      15. type 未定义（`{}`）按非 TEXT 处理 → hasMedia=true。
    - 断言强度：使用 `toEqual` 精确对象 / `toBe` 精确值，未使用 toBeTruthy 等弱断言。
  - tests/channel/channel.test.ts（修改）
    - 删除 2 个 D15 用例：
      · "D15 基线：首条即为文本且以 / 开头时判定为 slash command"（destination：迁移 → inbound-parser.test.ts 用例 7/8，两断言逐字保留）；
      · "D15 目标：应能识别非首条文本中的 slash command"（destination：迁移 → inbound-parser.test.ts 用例 11，断言逐字保留）。
    - 原因：两用例直接绑定已删除的私有方法 `Channel.isSlashCommand`；其行为断言被等价迁移而非丢弃。
    - 原位置保留注释说明去向（可追溯）。
    - 其余 slash / contextToken / 队列 / 媒体 / F6 用例零改动；`MessageItemType` import 仍被 F6/B5 用例使用，保持不变。
  - 目的地汇总：删除 2 例（均为「迁移」，非失效/被蕴含）；无断言被削弱或删 expect。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 5 个文件：
  - src/channel/inbound-parser.ts（新增）
  - src/channel/channel.ts（修改）
  - src/channel/router.ts（修改）
  - tests/channel/channel.test.ts、tests/channel/inbound-parser.test.ts
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、src/storage/**、src/index.ts、
  src/channel/{polling,queue,typing,sender,media-store,state,request-id}.ts 零 diff；
  dev（490a76a）为 HEAD 祖先；未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（189 pass / 21 files / 0 fail / 531 expect calls；允许低于/高于 baseline）
  - [x] 新增 `src/channel/inbound-parser.ts`，导出 `parseInbound`（纯函数，无副作用）
  - [x] `src/channel/channel.ts` 删除 `extractText` / `isSlashCommand`（`rg "extractText|isSlashCommand" src/channel/channel.ts` 无命中）；改用 `parseInbound`
  - [x] `src/channel/router.ts` 的 `execute()` 不再内联 `item_list?.some(...)` 判定与文本拼接，改用 `parseInbound`（`content = parsed.text`）
  - [x] 解析语义与「行为契约」逐条一致（新用例逐条覆盖）
  - [x] `Channel` / `MessageRouter` 公共 API 与窄接口契约不变（仅删除私有方法、私有方法签名调整）
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{inbound-parser,channel,router}.ts`、`tests/channel/**`
  - [x] result 的 test-changes ledger 完整，无削弱断言
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] `text`：仅 TEXT 项取 `text_item?.text ?? ""`，以 `"\n"` 拼接，不 trim、不过滤空串（逐字等价）
  - [x] `isCommand`：遍历全部 TEXT 项，任一 `(text ?? "").trim().startsWith("/")` 即 true
  - [x] `hasText`：存在 TEXT 项且 `text_item?.text?.trim()` 为真（空白不算）
  - [x] `hasMedia`：存在 `type !== TEXT` 的 item（含 type 未定义）
  - [x] 空消息 / item_list 缺失：`text=""`、`isCommand=false`、`hasText=false`、`hasMedia=false`
  - [x] router.execute 分支判定与注入内容不变：纯媒体（hasMedia && !hasText）ack + 后台入队 + mark + 排空（F6 ack 失败隔离不变）；文本 `appendEntry("wechat_meta",{requestId})` + `sendUserMessage(content,{deliverAs:"followUp"})`
  - [x] channel.handleMessage 顺序不变：slash 早退先于 contextToken 更新与 AI 派发；slash 路径仅解析一次（parsed 传入 handleSlashCommand）
  - [x] Channel 公共方法签名 / 文案 / 持久化 / 端口签名不变
notes: |
  - 单一批量原子提交：本次为一个逻辑（抽取纯解析器并消除 channel/router 重复解析），
    prod 修改与新模块 + 测试同步放入同一 commit，避免中间不可编译状态。
  - `handleMessage` 在进入 contextToken 分支前调用一次 `parseInbound`，把解析结果中的
    `isCommand` / `text` 分别用于早退判定与命令文本，避免重复解析；`parseInbound` 为纯函数，
    不影响 handleMessage 的顺序语义。
  - `channel.test.ts` 中两例 D15 直接绑定私有方法，随方法删除而迁移到新模块测试；注释保留去向，
    防止后续审计误判为无去向删除。
  - tests/README.md 中 D15 行仍引用旧方法名，但该文件不在本阶段 scope（非 tests/channel/**），
    未修改以免越界；不影响 `src/channel/channel.ts` 的 rg 零命中验收。
  - 未决项 / 需 human 决策：无。
