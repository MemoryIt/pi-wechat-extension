status: done
branch: refactor/pa-9-index-assembles-adapters
commits:
- 61a202517dde8d2e9d9d6a3f784f8bff67852a58 refactor(channel): ChannelState 提供 getCredentials/getOpts
- 4482d98b64434362b40415836a12a929ad7847ab refactor(index): 组合根组装 ChannelState + adapters
- 5f355312e69cdbc1a5d567f5f2372823f5abdd5f refactor(channel): Channel 只依赖 ports（移除缺省 adapters 构造，ports 必填）
- 57ee837528be21f6a598993757f3c58dc7d18e3b test: 构造改为注入 state + ports
- 45b50fb80222ac8fdb7fade66a84fbdb882d9343 docs: 更新依赖方向（index 组装 adapters）
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（129 pass / 15 files / 0 fail / 370 expect calls）
test-changes: 新增 2，重命名 0，删除 0
  - 新增 tests/unit/channel-state.test.ts：「getCredentials：config/userId/contextToken 齐备时组装凭证，缺一返回 null」与「getOpts：有 config 时返回 baseUrl/token，否则 null」（覆盖迁移出的新公开方法）
  - 修改（非新增/删除用例，仅构造注入）tests/channel/channel.test.ts、tests/integration/channel-flow.test.ts：`new Channel({ state: new ChannelState(), ports: {...}, host, config })`，断言语义未变
  - 修改 tests/setup/channel-harness.ts、tests/README.md：文档性说明同步为 ports 必填 + 注入 state
scope-check: 未越界。改动清单（vs dev）：
  - src/channel/state.ts（新增 getCredentials/getOpts，仅读 state 字段）
  - src/channel/channel.ts（移除 adapters import + 缺省构造；ports 必填；私有 getCredentials/getCurrentOpts 委托 state）
  - src/index.ts（组合根组装 ChannelState + inbound/outbound/media + Channel，outbound.getCredentials 读同一 state）
  - tests/**（构造注入 state+ports；channel-state 新用例）
  - docs/ARCHITECTURE.md、docs/c4/03-components.puml、03a-channel.puml、03b-ports-adapters.puml、04-class-channel.puml
  - vendor（api/auth/cdn/media/messaging/util）零 diff；`src/bridge/**` 零 diff
  - 未改 package.json / bun.lock / tsconfig.json；未新增依赖；未 push；未改 base（dev 为 HEAD 祖先）
acceptance:
  - [x] `bun run typecheck && bun run test` 全绿，129 pass ≥ 基线 127（新增 2）
  - [x] `rg "adapters" src/channel` 为空
  - [x] `src/index.ts` 组装 ChannelState + inbound/outbound/media + Channel；outbound.getCredentials 闭包读同一 state
  - [x] `ChannelPorts.{inbound,outbound,media}` 与 `ChannelDeps.ports` 必填；无缺省 adapter 构造
  - [x] 行为不变：凭证/typing/sender/媒体/复位语义与 S8 一致（全量回归 129 绿）
  - [x] docs 无「过渡 / 待迁 index / channel 缺省构造 adapters」残留（`rg "过渡|待迁|缺省构造" docs` 为空）
  - [x] vendor 目录零 diff；`src/bridge/**` 零 diff
  - [x] 关键回归 D3/D6/D7/D9/D13/D14/D15/D16/D16b/B4/B5/B6/C9 + channel-flow 集成用例全绿
  - [x] 提交原子、message 规范（5 个 commit，按建议拆分；顺序调整为先 index 后 channel 以保证每个 commit 可编译/测试通过）
notes: |
  - 顺序调整：任务建议拆分为 state → channel → index → test → docs。为保持每个 commit 自洽（typecheck+test 全绿），
    改为 state → index → channel → test → docs：先从组合根注入真实端口，再收紧 Channel 构造签名与移除缺省构造。
    建议中的 5 条拆分主题与 commit message 一一对应，未合并/拆分逻辑单元。
  - `ChannelState.getCredentials()` 与迁移前 `Channel.getCredentials()` 逻辑逐字一致（config/userId/contextToken 任一缺失返回 null，
    否则组装 baseUrl/token/userId/contextToken）；`getOpts()` 与迁移前 `getCurrentOpts()` 一致（有 config 返回 baseUrl/token，否则 null）。
    Channel 保留同名私有方法作为 `state` 的薄委托，`canSend: () => this.getCredentials() !== null` 语义不变。
  - `src/index.ts` 即使注入 `deps.channel` 也会创建 logger/state/ports（与任务书给定代码片段一致）；端口工厂为惰性闭包，不产生额外运行时行为或时序变化。
  - 文档仅做依赖方向同步（index 组装 port 实现 + ChannelState；channel 只依赖 ports/storage/shared），C4 图未做渲染校验
    （环境无 plantuml/java）；改动为文本级，括号/宏与原有约定一致。
  - 未决项 / 需 human 决策：无。
