# Task: CS-4 凭证加载抽取（credential-loader）

base: dev
branch: refactor/cs-4-credential-loader
model: opencode-go/deepseek-flash
start: pi --approve --provider opencode-go --model deepseek-flash
tests: bun install --frozen-lockfile && bun run typecheck && bun run test
baseline: 184 pass / 21 files / 0 fail
test-policy:
  硬底线：全绿 / 0 fail / typecheck 零错误。
  数量：允许 pass/files 计数变化（含下降）；「≥ 基线」不作为通过条件。
  覆盖面：被断言的外部行为集合不得缩小。
  删除/修改用例必须逐条给出去向（迁移 / 被蕴含 / 失效），写入 result 的 test-changes ledger。
  断言强度：不得削弱（禁止 toBe→toBeTruthy、删 expect、放宽精确值）。
  新增：本阶段新增的公共行为必须有用例覆盖。
invariant: 正常路径行为不变；Channel 公共 API / 文案 / 持久化 / 端口签名不变
commit: 原子提交（一个逻辑一个 commit）；禁止 push；禁止改 base 分支

## 现象（问题）

“从 storage 读凭证并写入运行期 state”这段逻辑仍内联在通道编排器里：

- `src/channel/channel.ts` 的 `initSession()`：调 `storage.getSingleUserCredentials()` →
  写 `state.userId/accountId` → 调 `storage.getSingleUserContextToken()` → 写 `state.contextToken` + 日志。
- `PollingLoopDeps.ensureSession` 直接指向 `() => this.initSession()`，
  即 **poller 的回调指回 Channel 方法**（构造期回调闭环的一半，另一半是 cs-5 的 `onMessage`）。

凭证加载属于「会话基础设施协作」，不应由通道编排器承担。

## goal

把凭证加载抽成独立协作类 `CredentialLoader`：

- 新增 `src/channel/credential-loader.ts`，承载现 `initSession` 的逻辑。
- `Channel.initSession()` 保留为**公共 API 委托**（`channel.test.ts` 有 14 处把它当 setup 用），签名与行为不变。
- `poller.ensureSession` 指向 `credentialLoader.ensureSession`，**不再指向 Channel 方法**（移除闭环的一半）。

## scope

prod（新增）：
- `src/channel/credential-loader.ts`
  ```ts
  import * as storage from "../storage/state.js";
  import type { ChannelState } from "./state.js";
  import type { PluginLogger } from "../shared/logger.js";

  export interface CredentialLoaderDeps { state: ChannelState; logger: PluginLogger; }

  export class CredentialLoader {
    constructor(deps: CredentialLoaderDeps);
    async ensureSession(): Promise<boolean>;   // = 原 Channel.initSession
  }
  export function createCredentialLoader(deps: CredentialLoaderDeps): CredentialLoader;
  ```

prod（修改）：
- `src/channel/channel.ts`
  - 新增 `private readonly credentialLoader: CredentialLoader;`，在构造函数中**先于 poller** 创建。
  - `poller` 的 `ensureSession` 改为 `() => this.credentialLoader.ensureSession()`。
  - `initSession()` 保留为公共委托：`async initSession(): Promise<boolean> { return this.credentialLoader.ensureSession(); }`。
  - 删除 Channel 内联的凭证读取实现体，以及仅它使用的 `storage.getSingleUser*` 直接调用（`storage.saveContextToken` 等其它调用保留）。

tests（新增）：
- `tests/channel/credential-loader.test.ts`：直接单测 `CredentialLoader`。

## 行为契约（必须逐字保持）

- 顺序：`storage.getSingleUserCredentials()`；**仅在拿到 credentials 时**才 `storage.getSingleUserContextToken()`。
- 无 credentials：`logger.error("No logged in account found")`，返回 `false`，**不改动 state**。
- 有 credentials：写 `state.userId = credentials.userId`、`state.accountId = credentials.accountId`，
  再写 `state.contextToken = <token|null>`。
- 无 contextToken：`logger.warn("No context token found, replies may fail")`，仍返回 `true`。
- 日志：`logger.debug("Single user initialized: userId=<id>, contextToken=present|MISSING")`。
- 返回值：有 credentials → `true`；无 → `false`。
- `Channel.initSession()` 对外行为与现状完全一致（含返回值与 state 副作用）。

## test-plan

- 新增 `tests/channel/credential-loader.test.ts`（直接测 loader，注入 fake state 与 logger / 或真实 state + 临时存储）：
  - 无凭证 → 返回 false、error 日志、state 未被改动。
  - 有凭证 + 有 contextToken → 返回 true、state.userId/accountId/contextToken 正确、debug 含 `present`。
  - 有凭证 + 无 contextToken → 返回 true、state.contextToken=null、warn 被调用、debug 含 `MISSING`。
  - 无凭证时**不**调用 `getSingleUserContextToken`（顺序/短路语义）。
- `tests/channel/channel.test.ts`：既有 `channel.initSession()` 用例保持通过（委托后行为不变）；如 import/构造受影响仅同步。

## acceptance

- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、typecheck 零错误（贴计数；允许低于 baseline）
- [ ] 新增 `src/channel/credential-loader.ts`，导出 `CredentialLoader`（及可选工厂）
- [ ] `src/channel/channel.ts` 的 `initSession` 为委托；凭证读取实现体已移出
- [ ] `poller.ensureSession` 指向 `credentialLoader.ensureSession`（不再 `this.initSession`）
- [ ] 行为契约逐条一致（新用例覆盖）
- [ ] `Channel` 其余公共 API / 文案 / 持久化 / 端口签名不变
- [ ] `git diff dev...HEAD --stat` 仅限 `src/channel/{credential-loader,channel}.ts`、`tests/channel/**`
- [ ] result 的 test-changes ledger 完整，无削弱断言
- [ ] 提交原子、message 规范（`refactor(channel): ...`）

## forbidden

- 不得修改 vendor（`api/ auth/ cdn/ media/ messaging/ util/`、`types/*.d.ts`）
- 不得改动 `src/ports/**`、`src/adapters/**`、`src/application/**`、`src/bridge/**`、`src/shared/**`、`src/storage/**`、`src/index.ts`、其它 `src/channel/*.ts`
- 不得新增依赖
- **不得 push**；不得改 `dev` 分支
- 不得删除/削弱既有测试断言；不得以「简化」为由删除无去向的测试

## report

完成后写 `/tmp/pi-tasks/cs-4.result.md`（schema：status / branch / commits / tests / test-changes(ledger) /
scope-check / acceptance / invariants / notes），并执行：

`tmux wait-for -S task-cs-4`
