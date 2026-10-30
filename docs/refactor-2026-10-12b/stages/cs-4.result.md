status: done
branch: refactor/cs-4-credential-loader
commits:
- 0e3449338a509b92e2be3c474dceb67e200935e5 refactor(channel): 抽取凭证加载为 CredentialLoader 协作类
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （188 pass / 22 files / 0 fail / 556 expect calls；基线 184 / 21 / 0 / 528；
   typecheck 零错误；install frozen-lockfile 无改动）
test-changes:
  - 既有用例：零修改、零删除、零削弱（channel.test.ts 的 14 处 `channel.initSession()`
    setup 调用全部随公共委托原样通过；其余既有用例零改动）。
  - 新增 tests/channel/credential-loader.test.ts（新增 4 用例、28 expect calls）：
    1. "无凭证：返回 false、error 日志、state 未被改动、短路不查 contextToken"
       - `mock.module` 注入 storage fake，`getSingleUserCredentials` 返回 null；
         断言 `ensureSession() === false`、`logger.error` 恰被调用 1 次且参数为
         `"No logged in account found"`、`getSingleUserContextToken` **未**被调用（短路）、
         `state.userId/accountId/contextToken` 仍为 null。
    2. "有凭证 + 有 contextToken：返回 true，state 写入正确，debug 含 present"
       - 断言返回 true、`state.userId==="U1"`、`state.accountId==="acc1"`、
         `state.contextToken==="CTX-1"`、`getSingleUserContextToken` 恰 1 次、
         `logger.warn` 未调用、`logger.debug` 参数精确为
         `"Single user initialized: userId=U1, contextToken=present"`。
    3. "有凭证 + 无 contextToken：返回 true、state.contextToken=null、warn 被调用、debug 含 MISSING"
       - 断言返回 true、`state.contextToken===null`、`logger.warn` 参数精确为
         `"No context token found, replies may fail"`、`logger.debug` 参数精确为
         `"Single user initialized: userId=U1, contextToken=MISSING"`。
    4. "工厂 createCredentialLoader：返回可用 loader，委托行为一致"
       - 断言工厂产物 `toBeInstanceOf(CredentialLoader)`，且 `ensureSession()` 行为一致
         （返回 true 且 state 写入正确），覆盖新增工厂公共行为。
  - 覆盖对照 task test-plan：无凭证 false/error/state 不变 ✓；有凭证+有 token ✓；
    有凭证+无 token → warn/MISSING/null ✓；无凭证不调用 `getSingleUserContextToken` ✓
    （第 1 例显式断言）。
  - 断言强度：全部使用 `toBe` 精确值 / `toHaveBeenCalledWith` 精确参数 /
    `toHaveBeenCalledTimes` 精确次数；无 toBeTruthy 弱化、无删 expect、无放宽精确值。
scope-check: 未越界。`git diff dev...HEAD --stat` 仅 3 个文件：
  - src/channel/channel.ts（修改，+11/-20）
  - src/channel/credential-loader.ts（新增，67 行）
  - tests/channel/credential-loader.test.ts（新增，148 行）
  vendor（api/ auth/ cdn/ media/ messaging/ util/、types/*.d.ts）零 diff；
  package.json / bun.lock 零 diff；未新增依赖；
  src/ports/**、src/adapters/**、src/application/**、src/bridge/**、src/shared/**、
  src/storage/**、src/index.ts、src/channel/{inbound-parser,media-store,polling,queue,
  request-id,router,sender,state,typing}.ts、tests/setup/** 零 diff；
  dev（0c5bfcf）为 HEAD 祖先；未切换分支、未改 dev、未 push。
acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail、
        typecheck 零错误（188 pass / 22 files / 0 fail / 556 expect calls；高于基线属新增用例）
  - [x] 新增 `src/channel/credential-loader.ts`，导出 `CredentialLoader`（及工厂 `createCredentialLoader`）
  - [x] `src/channel/channel.ts` 的 `initSession` 为委托（`return this.credentialLoader.ensureSession()`）；
        凭证读取实现体已移出（`rg "getSingleUser" src/channel/channel.ts` 无命中）
  - [x] `poller.ensureSession` 指向 `() => this.credentialLoader.ensureSession()`（不再 `this.initSession`）
  - [x] 行为契约逐条一致，且新用例逐条覆盖（顺序/短路、无凭证、有凭证、缺 token、日志、返回值）
  - [x] `Channel` 其余公共 API / 文案 / 持久化 / 端口签名不变（其余 `storage.*` 调用保留未动）
  - [x] `git diff dev...HEAD --stat` 仅限 `src/channel/{credential-loader,channel}.ts`、`tests/channel/**`
  - [x] result 的 test-changes ledger 完整，无削弱断言
  - [x] 提交原子、message 规范（`refactor(channel): ...`）
invariants:
  - [x] 正常路径行为不变：`Channel.initSession()` 载荷/顺序/返回值/日志与抽取前逐字一致；
        poller 启动时的 session 初始化路径改经 loader，行为等价
  - [x] 顺序契约：先 `storage.getSingleUserCredentials()`；**仅当**拿到 credentials 才
        `storage.getSingleUserContextToken()`（第 1 例显式断言短路）
  - [x] 无 credentials：`logger.error("No logged in account found")` → 返回 false、state 不变
  - [x] 有 credentials：写 `state.userId` / `state.accountId`，再写 `state.contextToken`
  - [x] 无 contextToken：`logger.warn("No context token found, replies may fail")`，仍返回 true
  - [x] debug 文案精确：`Single user initialized: userId=<id>, contextToken=present|MISSING`
  - [x] `Channel` 公共 API / 文案 / 持久化 / 端口签名不变；`storage.saveContextToken` /
        `loadSyncCursor` / `saveSyncCursor` 调用保留
  - [x] 依赖方向不变：`src/channel/credential-loader.ts` 仅依赖 `storage/`、`./state.js`、
        `shared/logger.js`（类型），不 import vendor / engine / 适配层
notes: |
  - 单一批量原子提交：本阶段为一个逻辑（抽出凭证加载协作类），prod 新增/修改 +
    新增测试放入同一 commit，避免中间不可编译状态。
  - `initSession` 保留为公共委托（channel.test.ts 有 14 处把它当 setup 用），
    签名 `(): Promise<boolean>` 与对外行为完全一致。
  - 构造函数中 `credentialLoader` 先于 `poller` 创建（满足任务书要求）；poller 的
    `ensureSession` 闭包改为 `this.credentialLoader.ensureSession()`，解除
    「构造期回调指回 Channel 方法」闭环的一半（另一半 onMessage 留待 cs-5）。
  - 测试策略：`credential-loader.test.ts` 用 `mock.module(repoPath("src","storage","state.js"))`
    注入可控 storage fake（在 import CredentialLoader 前安装），配合 fake logger，
    从而可断言短路语义（`getSingleUserContextToken` 未被调用）与日志参数精确值；
    bun `--isolate` 保证该模块级 mock 不影响 channel.test.ts 的真实 storage 路径。
  - 未决项 / 需 human 决策：无。
