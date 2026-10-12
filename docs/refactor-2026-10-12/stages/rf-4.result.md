status: done
branch: refactor/rf-4-connecting
commits:
- 2f49cedb2652e6a1ffccd56c9d1a7a120c699602 fix(channel): startPolling 同步进入 connecting
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（160 pass / 18 files / 0 fail / 458 expect calls；基线 158 / 18 / 0，新增 2 例）
test-changes: 新增 2，修改 0，删除 0
  - 新增 tests/channel/channel.test.ts「A3 目标：startPolling 后、首次 getUpdates 返回前 connectionState === 'connecting'」：
    首次 getUpdates 手动挂起 → `channel.startPolling(opts)` 后立即断言 `connectionState === "connecting"`；
    resolve 首次结果 `{ messages: [], cursor: "" }` → `waitFor(connected)`；`stopPolling()` 并 await p 后回 `disconnected`。
  - 新增 tests/channel/channel.test.ts「A3 可选：ensureSession 无凭证时 startPolling 结束后为 disconnected（不卡 connecting）」：
    `resetAgentDir()` 清空凭证 → 立即断言同步 `connecting` → await startPolling 结束后为 `disconnected`。
  - 既有 D3/D9/needs_relogin（B4）等用例零改动、断言未削弱，全部通过。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 2 个文件：
  - src/channel/polling.ts（+4：在重入守卫之后、`ensureSession()` 之前同步置 `connectionState = "connecting"`）
  - tests/channel/channel.test.ts（+42：新增 A3 两个用例）
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖；
    src/application/**、src/bridge/**、src/ports/**、src/adapters/**、src/channel/ 下 polling.ts 以外文件零 diff；
    dev 为 HEAD 祖先，未 push
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，160 pass / 18 files ≥ 158；typecheck 零错误
  - [x] src/channel/polling.ts 的 `start()` 在 `ensureSession()` 前同步置 `connecting`
  - [x] 新增 A3 用例通过（目标用例 + 可选用例均 pass）
  - [x] `git diff dev...HEAD --stat` 仅限 src/channel/polling.ts 与 tests/channel/channel.test.ts
  - [x] 提交原子（prod + 对应测试同属一个逻辑，单 commit；可编译 / 测试通过），message 规范
behavior-contract:
  - [x] `start()` 未被重入守卫拦截时，调用后同步为 `"connecting"`（在 `await ensureSession()` 之前）
  - [x] 首次 `getUpdates` 成功返回 → `"connected"`
  - [x] `ensureSession()` 返回 false（无凭证）→ 循环退出后为 `"disconnected"`（finally 回落，不卡 connecting）
  - [x] `stop()` / `reset()` → `"disconnected"`（现状保持）
  - [x] 会话过期（`errcode/code === -14`）→ `"needs_relogin"`（finally 不覆盖终态，B4 用例保持通过）
  - [x] 重入（`pollingActive === true`）→ 直接返回，不改变当前状态（D3 用例保持通过）
  - [x] `Channel.connectionState` getter 仍委托 `poller.connectionState`；`/wechat status` 文案 `Connection: ${channel.connectionState}` 未改
notes: |
  - 唯一改动点：`src/channel/polling.ts` 的 `start()`，在 `this.pollingActive = true; const generation = ++this.pollingGeneration;`
    之后、`ensureSession()` 之前插入 `this.state.connectionState = "connecting"`。该赋值位于 `await` 之前，故「同步」生效；
    其余 start/stop/reset/循环逻辑与状态真相源（仍在 PollingLoop）不变。
  - 未引入 `SessionService.phase` 或第二份连接状态；公共 API / 文案 / 持久化零改动。
  - 可选 A3 用例通过 `resetAgentDir()` 造无凭证场景，验证不会卡在 connecting。
  - 未决项 / 需 human 决策：无。
