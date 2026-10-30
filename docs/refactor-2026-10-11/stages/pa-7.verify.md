# PA-7 验证报告

- verdict: **PASS**
- base-branch（受验分支）: `refactor/pa-7-remove-engine`
- base(dev): `cecc37cb313629afa5f9107131d7815e37d1964a`
- HEAD: `7f8be3a96cbeeddcda07859cb76a29b2e01c0e10`
- 提交链：`dev(cecc37c) → 69f0b9f → 03a9835 → 7f8be3a`，线性 3 个原子提交
- `dev` 为 `HEAD` 祖先（`git merge-base --is-ancestor dev HEAD` 为真）；`dev == origin/dev`（base 未移动）
- verifier: 只读；未修改代码、未提交、未 push（仅 `bun install` 校验 lockfile 与写本报告）
- 工作树 clean（`git status --porcelain` 空）

---

## 1. 构建 / 测试（check 1 & 2）—— PASS

命令链：
```
bun install --frozen-lockfile && bun run typecheck && bun run test
```
结果：

| 项 | 结果 |
| --- | --- |
| install | `Checked 131 installs across 139 packages (no changes) [3.00ms]` |
| typecheck | `tsc --noEmit` 无输出，exit 0 |
| test | **127 pass / 0 fail / 364 expect() calls / Ran 127 tests across 15 files** |

基线核对（与 `pa-7.result.md` 的 `test-changes` 一致）：

```
dev 127 pass / 15 files → HEAD 127 pass / 15 files（净 0；重命名 5，新增 0，删除 0）
```

逐文件 pass 计数（HEAD）：
```
tests/bridge/turn-state.test.ts          6    tests/channel/channel.test.ts      21
tests/bridge/meta.test.ts                2    tests/channel/queue.test.ts         9
tests/bridge/event-wiring.test.ts        9    tests/channel/media-store.test.ts  12
tests/bridge/turn.test.ts                8    tests/channel/router.test.ts        9
tests/integration/channel-flow.test.ts   5    tests/unit/channel-state.test.ts    4
tests/unit/dependencies.test.ts          2    tests/unit/config.test.ts           5
tests/unit/logger.test.ts               10    tests/unit/adapters.test.ts        19
tests/unit/storage.test.ts               6
------------------------------------------------------------
合计 127 pass / 15 files / 0 fail
```
测试用例数 `127 ≥ 基线 127`；无 `test.skip/only/todo`（`rg "(test\.(skip|only|todo)|\.skip\()" tests` 无命中）。
迁移前后用例数逐文件守恒：`engine.test.ts 21→channel.test.ts 21`、`media-store 12→12`、`queue 9→9`、`router 9→9`。

## 2. src/engine 删除（check 5 前半）—— PASS

```
test -d src/engine                         # 假（absent）
rg -n "src/engine|engine/wechat" src tests # 无匹配（exit 1）
```
`git ls-tree -r dev -- src/engine` → `src/engine/wechat.ts`（dev 存在），HEAD 已删除（`git diff dev...HEAD`：`D src/engine/wechat.ts`，194 行删除）。

## 3. 残留 WechatEngine 引用（check 6）—— PASS

```
rg -n "\bWechatEngine\b|createWechatEngine" src tests   # 无匹配（exit 1，注释也已清理）
```
`git show dev:tests/setup/engine-harness.ts | rg "WechatEngine|createWechatEngine|importEngine"` 有旧引用；HEAD 已清零。
运行时字符串 `"WechatHost not configured"`（`src/channel/router.ts:75,164`）按任务书 scope **保留原样**（无测试断言，改则引入行为变化）：check 仅要求 `WechatEngine|createWechatEngine` 为空。

## 4. tests 结构与直接测 Channel（check 7 & 8）—— PASS

```
tests/channel/  → channel.test.ts / media-store.test.ts / queue.test.ts / router.test.ts   （4 个，齐全）
tests/setup/channel-harness.ts 存在
tests/setup/engine-harness.ts  不存在
tests/engine/                  不存在
```
- `tests/channel/channel.test.ts` 存在，且**直接** `new Channel({ host, config, ports: { inbound, outbound, media } })`（`makeChannel`），不再经门面。迁移映射核对无误：`initSession` / `startTyping` / `stopTyping` / `sendReply` / `sendFile`、`(channel as any).state/queue/router`。
- `channel-harness.ts`：`installChannelMocks() / importChannel() / createChannelPi()`；`installBaseMocks()` 不替换微信边界；端口 fake（inbound/outbound/media）与 fixture/seed 与旧 harness 语义一致。
- `tests/channel/router.test.ts` 直接 `import { MessageRouter } from "../../src/channel/router.js"`；`queue.test.ts` 直接 `TurnQueue/SerialTaskQueue`；`media-store.test.ts` 直接 `MediaStore`。均无 `engine` 引用。

## 5. dependencies CORE_FILES（check 9）—— PASS

`tests/unit/dependencies.test.ts`：
```
const CORE_FILES = ["src/index.ts", "src/channel/channel.ts", "src/shared/config.ts", "src/storage/state.ts"];
```
（dev 为 `src/engine/wechat.ts`）；该文件 2 个用例实跑 pass（`D22` ×2）。`src/channel/channel.ts` 存在。

## 6. 回归用例逐条核对（check 10）—— PASS

全部仍在且实跑 pass（`bun test --isolate`，从输出提取）：

| 用例 | 文件 | 结果 |
| --- | --- | --- |
| D3 重复 startPolling 不并发两条轮询循环 | channel.test.ts | pass |
| D6 sendUserMessage 抛错释放 isAiProcessing 不冒泡 | channel.test.ts | pass |
| D7 队列排空 rejecting turn 由通道处理并释放状态 | channel.test.ts | pass |
| D9 限制说明：getUpdates 不收 AbortSignal | channel.test.ts | pass |
| D9 stopPolling 后 startPolling 在 300ms 内 resolve | channel.test.ts | pass |
| D13 同一毫秒 requestId 唯一 | channel.test.ts | pass |
| D14 基线：sendFile 以本地路径提交、单参（无 display-name） | channel.test.ts | pass |
| D15 基线：首条文本 / 开头判定 slash | channel.test.ts | pass |
| D15 目标：非首条文本中的 slash 可识别 | channel.test.ts | pass |
| D16 contextToken 变化后重新获取 typing ticket | channel.test.ts | pass |
| D16 ticket 缓存 60s TTL 命中 / 过期重取 | channel.test.ts | pass |
| D16 sendTyping 报错含 'ticket' 清缓存重取 | channel.test.ts | pass |
| D16b typing keepalive interval 调用 unref | channel.test.ts | pass |
| D4 前一微信 turn 回复不被后一终端 turn 覆盖 | bridge/turn-state.test.ts | pass |
| D4 wechat_meta 位于最后一条 assistant 之后判为微信 turn | bridge/turn-state.test.ts | pass |
| D4 微信 turn 之后的终端 turn 不被误判 | bridge/turn-state.test.ts | pass |
| B4 needs_relogin 通知用户 /wechat login | channel.test.ts | pass |
| B5 媒体立即 ack（不含路径）、下载未完成不写 history | channel.test.ts | pass |
| B5 后台媒体任务串行，第 2 条等第 1 条 resolve | channel.test.ts | pass |
| B6 排队一一对应 requestId/content、不丢 | channel.test.ts | pass |
| C9 两个 Channel 实例互不污染（改为 Channel 实例隔离） | channel.test.ts | pass |

计数：D3×1、D4×3、D6×1、D7×1、D9×2、D13×1、D14×1、D15×2、D16×3、D16b×1、B4×1、B5×2、B6×1、C9×1（=21 个迁移用例）。

## 7. 未削弱既有集成 / 单测（check 11）—— PASS

```
git diff dev...HEAD -- tests/integration/channel-flow.test.ts tests/unit/channel-state.test.ts   # 空（未改）
```
两文件在 HEAD 实跑均 pass（channel-flow 5、channel-state 4）。断言未削弱。

## 8. 边界 / 越界 & vendor（check 3）—— PASS

`git diff dev...HEAD --name-status`（12 项，全部在 scope 内）：
```
M src/channel/channel.ts        M src/channel/router.ts        M src/channel/state.ts
D src/engine/wechat.ts          M src/ports/pi-host.ts         M tests/README.md
R074 tests/engine/engine.test.ts      -> tests/channel/channel.test.ts
R099 tests/engine/media-store.test.ts -> tests/channel/media-store.test.ts
R099 tests/engine/queue.test.ts       -> tests/channel/queue.test.ts
R099 tests/engine/router.test.ts      -> tests/channel/router.test.ts
R087 tests/setup/engine-harness.ts    -> tests/setup/channel-harness.ts
M tests/unit/dependencies.test.ts
```
- **vendor 目录零 diff**：`git diff dev...HEAD --stat -- api auth cdn media messaging util types` 为空（本仓 vendor 代码位于 `api/ auth/ cdn/ media/ messaging/ util/ types/`，无字面 `vendor/`）。
- `package.json` / `bun.lock` / `tsconfig.json` diff 为空（未新增依赖）。
- `src/channel/{channel,router,state}.ts`、`src/ports/pi-host.ts` 仅注释改动（逐行核对，运行时行为不变）；`"WechatHost not configured"` 字符串未动。
- 无 untracked，工作树 clean。

## 9. 提交原子性与 message（check 12）—— PASS

```
7f8be3a chore(test): 更新 tests/README 路径
03a9835 refactor(channel): 删除 WechatEngine 门面与 src/engine/
69f0b9f test(channel): 将 engine 测试迁移到 tests/channel 并直接测 Channel
```
- 三个提交各自单一逻辑、conventional commit（`type(scope): 中文描述`），body 说明变更与行为不变声明。
- 提交顺序说明合理：先迁移测试（prod 门面仍在，测试已不依赖它）→ 删门面（同时把 `dependencies.test.ts` CORE_FILES 改指 channel，避免删除后断测）→ README。故 result 所述「每提交全绿」在逻辑上自洽。
- 未 push；未改 base（`dev == origin/dev`）；`refactor/pa-7-remove-engine` 指向 `7f8be3a`。

---

## 备注（非阻塞）

1. `docs/ARCHITECTURE.md` 与 `docs/c4/03a-engine.puml`、`docs/c4/04-class-engine.puml` 仍引用已删除的 `src/engine/*`、`WechatEngine`、`createWechatEngine`。这些**不在本任务 scope**（acceptance 的 grep 明确限定 `src tests`，scope 的注释清理只列 `src/channel/*`、`src/ports/pi-host.ts`），属文档同步阶段范围，不影响本阶段判定。
2. `tests/unit/adapters.test.ts:10` 注释含普通词 “engine”（非 `WechatEngine`、非路径）；`tests/channel/channel.test.ts` 测试字符串 `"hello engine"` 为消息内容，均不构成残留实体引用。
3. 每提交粒度的全绿未逐 commit 复跑（只读约束下不 checkout）；已通过提交内容 + 提交链线性 + HEAD 全绿 + 逐提交 diff 逻辑核对论证。

## 命令清单

```
bun install --frozen-lockfile && bun run typecheck && bun run test   # exit 0, 127 pass / 15 files / 0 fail / 364 expect
test -d src/engine                                                    # 假
rg "src/engine|engine/wechat" src tests                               # 无匹配
rg "\bWechatEngine\b|createWechatEngine" src tests                    # 无匹配
ls tests/channel/ tests/setup/                                        # 4 测试 + channel-harness；无 engine-harness/engine/
rg CORE_FILES tests/unit/dependencies.test.ts                        # 指向 src/channel/channel.ts
git diff dev...HEAD --stat -- api auth cdn media messaging util types # 空（vendor 零 diff）
git diff dev...HEAD -- tests/integration/channel-flow.test.ts tests/unit/channel-state.test.ts  # 空
git diff dev...HEAD --name-status                                     # 12 项，全部在 scope
git log --oneline dev..HEAD                                           # 3 个原子提交
git merge-base --is-ancestor dev HEAD && git rev-parse dev origin/dev # dev 未移动
```
