# Verify Report: PA-9

- task: 把 adapter 组装上移到 index，消除 `channel → adapters` 依赖
- branch under test: `refactor/pa-9-index-assembles-adapters`
- HEAD: `45b50fb80222ac8fdb7fade66a84fbdb882d9343`（工作树干净，detached HEAD，ref 指向同一 commit）
- base: `dev`（`git merge-base --is-ancestor dev HEAD` = YES）
- mode: 只读验证（未修改代码 / 未提交）

## Verdict: **PASS**

全部 acceptance 满足，未发现阻断性问题。

## 1. 构建与测试

命令：`bun install --frozen-lockfile && bun run typecheck && bun run test`

```
bun install v1.4.2 (744846f84)
Checked 131 installs across 139 packages (no changes) [3.00ms]
$ tsc --noEmit
...
 129 pass
 0 fail
 370 expect() calls
Ran 129 tests across 15 files. [772.00ms]
test-exit=0  tc-exit=0
```

- typecheck 退出码 0，无输出。
- 测试 **129 pass / 15 files / 0 fail / 370 expect calls**。
- 基线（pa-8 验证确认）：127 pass / 15 files / 0 fail → 测试数 ≥ 基线（+2，文件数不变）。
- 与 result 的 test-changes 一致：新增 2（`tests/unit/channel-state.test.ts` 的 `getCredentials`/`getOpts`），无重命名/删除。
- 无 `test.skip`/`test.todo`/`.only`（仅 `config.test.ts` 注释与 README 提到 `test.failing` 术语，无实际修饰符）。

## 2. Scope 未越界

`git diff dev...HEAD --stat`：

```
 docs/ARCHITECTURE.md                   |  9 +++----
 docs/c4/03-components.puml             |  6 ++---
 docs/c4/03a-channel.puml               |  4 +--
 docs/c4/03b-ports-adapters.puml        |  2 +-
 docs/c4/04-class-channel.puml          | 27 ++++++++++++-------
 src/channel/channel.ts                 | 49 +++++++++-------------------------
 src/channel/state.ts                   | 26 ++++++++++++++++++
 src/index.ts                           | 23 +++++++++++++++-
 tests/README.md                        |  2 +-
 tests/channel/channel.test.ts          |  2 ++
 tests/integration/channel-flow.test.ts |  3 ++-
 tests/setup/channel-harness.ts         |  2 +-
 tests/unit/channel-state.test.ts       | 27 +++++++++++++++++++
 13 files changed, 120 insertions(+), 62 deletions(-)
```

- **vendor 零 diff**：`git diff dev...HEAD --stat -- api auth cdn media messaging util types` 输出为空。
- **`src/bridge/**` 零 diff**：同上命令包含 `src/bridge`，输出为空。
- `package.json` / `bun.lock` / `tsconfig.json` 零 diff，无新增依赖。
- 改动仅限任务书 scope（src/channel、src/index、tests、docs）。

## 3. 逐条 acceptance

| # | 验收项 | 结果 |
|---|--------|------|
| 1 | typecheck + test 全绿，用例 ≥ 127 | ✅ 129/15/0 |
| 2 | `rg "adapters" src/channel` 为空 | ✅ exit=1；`rg "createWechat\|from \"../adapters" src/channel` 亦为空 |
| 3 | index 组装 ChannelState + 3 adapters + Channel，outbound getCredentials 读同一 state | ✅ 见下 |
| 4 | `ChannelPorts.{inbound,outbound,media}` 与 `ChannelDeps.ports` 必填；无缺省 adapter 构造 | ✅ 见下 |
| 5 | 行为不变（凭证/typing/sender/媒体/复位） | ✅ 见下 |
| 6 | docs 无「过渡/待迁/缺省构造 adapters」残留 | ✅ `rg "过渡\|待迁\|缺省构造\|缺省 adapter" docs` 为空 |
| 7 | vendor 零 diff；`src/bridge/**` 零 diff | ✅ 见第 2 节 |
| 8 | 关键回归用例全绿 | ✅ 见下 |
| 9 | 提交原子、message 规范 | ✅ 见下 |

### 3.1 index 组装（`src/index.ts`）

```ts
const logger = createLogger({ isDebugEnabled: () => isDebugEnabled() });
const state = new ChannelState();
const ports = {
  inbound: createWechatInbound(),
  outbound: createWechatOutbound({ getCredentials: () => state.getCredentials(), logger }),
  media: createWechatMedia({ log: (m) => logger.debug(m), errLog: (m) => logger.error(m) }),
};
const channel = deps.channel ?? new Channel({ state, ports, logger });
```

- 唯一 `new ChannelState()` 实例同时交给 `outbound.getCredentials` 闭包与 `new Channel({ state, ... })`，即二者共享同一 state 实例，满足「outbound 读同一 state」。
- 三个 adapter 均显式组装（inbound/outbound/media），另外 `auth` 保持原样。

### 3.2 Ports 必填 / 无缺省构造

`src/channel/channel.ts` diff：

```diff
-/** 可注入的微信边界端口（测试用 fake；生产缺省时由本类构造 adapters）。 */
+/** 微信边界端口（生产由组合根注入真实端口实现；测试注入 fake）。 */
 export interface ChannelPorts {
-  inbound?: WechatInbound;
-  outbound?: WechatOutbound;
-  media?: WechatMedia;
+  inbound: WechatInbound;
+  outbound: WechatOutbound;
+  media: WechatMedia;
 }
...
-  ports?: ChannelPorts;
+  ports: ChannelPorts;
...
-  constructor(deps: ChannelDeps = {}) {
+  constructor(deps: ChannelDeps) {
...
-    const outbound = deps.ports?.outbound ?? createWechatOutbound({...});
-    const inbound = deps.ports?.inbound ?? createWechatInbound();
-    const media = deps.ports?.media ?? createWechatMedia({...});
+    const { inbound, outbound, media } = deps.ports;
```

- 三端口字段与 `ports` 均无 `?`；构造函数不再有 `= {}` 默认值；adapters import 与 `?? createWechat*` 缺省构造全部删除。
- `tsc --noEmit` 通过，证明所有调用点均提供 ports（类型层面强制必填）。

### 3.3 state 方法与语义

`src/channel/state.ts` 新增：

```ts
getCredentials(): WechatCredentials | null {
  const config = this.config;
  if (!config || !this.userId || !this.contextToken) return null;
  return { baseUrl: config.baseUrl, token: config.token, userId: this.userId, contextToken: this.contextToken };
}
getOpts(): WechatApiOpts | null {
  const cfg = this.config;
  return cfg ? { baseUrl: cfg.baseUrl, token: cfg.token } : null;
}
```

- 与迁移前 `Channel.getCredentials()` / `Channel.getCurrentOpts()` 逐行等价（diff 中旧实现原样搬入 state）。
- `Channel` 保留私有 `getCredentials()` / `getCurrentOpts()` 作为薄委托：`() => this.state.getCredentials()` / `() => this.state.getOpts()`；`sender` 的 `canSend: () => this.getCredentials() !== null` 语义不变。
- `resetSession()` 未变（清凭证/终端标志/请求追踪，保留 config/host/notifier），新方法只读字段。

### 3.4 行为不变抽查

- 凭证：逻辑逐字迁移，缺失判定与字段组装一致。
- typing ticket：`TypingController` 仍以 port outbound 为依赖，缓存/TTL/失效逻辑未改；D16/D16b 全绿。
- sender canSend：委托链指向同一 state，语义等价。
- 媒体：`MediaStore` 仍接收注入的 `media` port；后台串行队列未改；B5 全绿。
- reset：`typing.reset + queue.reset + state.resetSession + poller.reset` 未改，C9 隔离用例全绿。
- adapter 工厂均为无副作用的闭包返回（inbound/outbound/media 只返回对象，无 I/O），因此即使注入 `deps.channel` 也实例化 ports 不产生运行时/时序变化。

### 3.5 关键回归用例

全量 129 用例通过，其中点名用例（`tests/channel/channel.test.ts`）均存在且 PASS：

- D3（重复 startPolling 不并发）、D6（sendUserMessage 抛错释放）、D7（队列排空 rejecting turn）、D9（stopPolling 300ms resolve）、D13（同毫秒 requestId 唯一）、D14（sendFile 单参本地路径）、D15（非首条 slash）、D16（contextToken 变化重取 ticket / TTL / 错误清缓存）、D16b（keepalive unref）、B4（needs_relogin 通知）、B5（媒体立即 ack / 后台串行）、B6（终端期间连发按序排空）、C9（两 Channel 互不污染）。
- 集成用例 `tests/integration/channel-flow.test.ts` 5 个全绿：入站文本、入站媒体、typing、出站、reset。
- D14 以注释 `// D14：...` 标注，测试名「基线：sendFile 以本地文件路径提交…」，断言 `sendFile` 被调用一次且仅 1 个参数，未弱化。

### 3.6 提交原子 / message

5 个 commit（dev..HEAD，无 merge commit，计数 5，顺序 dev→HEAD）：

```
61a2025 refactor(channel): ChannelState 提供 getCredentials/getOpts   (state.ts + 其单测)
4482d98 refactor(index): 组合根组装 ChannelState + adapters           (index.ts)
5f35531 refactor(channel): Channel 只依赖 ports（移除缺省 adapters 构造，ports 必填） (channel.ts)
57ee837 test: 构造改为注入 state + ports                              (tests)
45b50fb docs: 更新依赖方向（index 组装 adapters）                     (docs)
```

- message 全部符合 conventional commits（`type(scope): subject`）。
- 每个 commit 只覆盖单一逻辑单元；顺序与任务建议不同（state→index→channel→test→docs），但结果已说明：先让组合根注入真实端口，再收紧 Channel 签名，可保证中间 commit 仍可编译/测试（index 在 channel 收紧前已传入 ports）。方向合理，主题与建议一一对应。

## 4. Docs

`git diff dev...HEAD -- docs/` 已将过渡表述替换为最终依赖方向：

- `ARCHITECTURE.md`：删除 `channel ──→ adapters/*（缺省构造……待迁 index）` 与「过渡状态」段，新增 `index ──→ adapters/*` 及「组合根组装端口」；模块职责表更新 index 为组装 `ChannelState + adapters + Channel`；删除「移除过渡职责」的待办。
- `03-components.puml`：删除 `Rel(channel, adapter, ...待迁 index)`，更新为 index 组装说明。
- `03a-channel.puml`：改述「只依赖注入端口；真实实现由 index 组装」。
- `03b-ports-adapters.puml`：`缺省构造真实 adapter` → `组装真实 adapter`。
- `04-class-channel.puml`：`ports?`→`ports`、三端口去 `?`；新增 `index` 组合根节点与 `ChannelState` 新方法；`Channel ..> adapters : 缺省构造` 改为 `index ..> adapters`。

残留检查：`rg "过渡|待迁|缺省构造|缺省 adapter|default.*adapter" docs` → 空（exit=1）。docs 中其余 `adapters` 提及均为正确方向描述（index→adapters、adapters→ports+vendor）。

## 5. 结论

**PASS**。PA-9 全部 acceptance 满足：channel 不再依赖 adapters，index 作为组合根组装 `ChannelState + 3 adapters + Channel` 且 outbound 与 Channel 共享同一 state；`ChannelPorts`/`ChannelDeps.ports` 必填、无缺省构造；`ChannelState.getCredentials()/getOpts()` 语义与迁移前一致；行为不变（129/15/0，关键回归 + 集成全绿）；vendor 与 `src/bridge/**` 零 diff；docs 无过渡残留；提交原子且 message 规范。无需 human 决策。
