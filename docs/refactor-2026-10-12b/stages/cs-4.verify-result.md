# CS-4 验证报告（只读子 Agent）

- 工作目录：`/tmp/wt-cs-4-verify`（detached HEAD @ `0e34493`）
- 分支：`refactor/cs-4-credential-loader`
- base：`dev` = `0c5bfcf`（`git merge-base dev HEAD` == `0c5bfcf`，dev 为 HEAD 祖先）
- 验证时间：见文件 mtime
- 结论：**PASS**（全部 12 项 check 通过；仅 1 处 ledger 计数笔误，不影响验收）

---

## 1. 全绿门禁（install / typecheck / test）

命令与结果：

```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
130 packages installed [134.00ms]        # 无 lockfile 变更

$ bun run typecheck
$ tsc --noEmit
TYPECHECK_EXIT=0                          # 0 错误

$ bun run test      # bun test --isolate
 188 pass
 0 fail
 556 expect() calls
Ran 188 tests across 22 files. [1033.00ms]
TEST_EXIT=0
```

- 基线 `184 pass / 21 files / 0 fail`；当前 `188 pass / 22 files / 0 fail`（+4 tests / +1 file，属新增用例）。**允许低于/变化，此处为上升，不构成通过依据。**
- 硬底线：全绿 / 0 fail / typecheck 零错误 → **满足**。
- **判定：PASS**

## 2. 越界检查（`git diff dev...HEAD --stat`）

```
 src/channel/channel.ts                  |  31 +++----
 src/channel/credential-loader.ts        |  67 +++++++++++++++
 tests/channel/credential-loader.test.ts | 148 ++++++++++++++++++++++++++++++++
 3 files changed, 226 insertions(+), 20 deletions(-)
```

- 仅 `src/channel/{credential-loader,channel}.ts` 与 `tests/channel/**`。**PASS**
- 额外证据（以下全部为空 diff）：
  - vendor：`api/ auth/ cdn/ media/ messaging/ util/ types/*.d.ts` → 空
  - 新增依赖：`package.json` / `bun.lock` → 空
  - 禁止目录：`src/ports src/adapters src/application src/bridge src/shared src/storage src/index.ts` → 空
  - 其它 `src/channel/*.ts`（除 channel.ts / credential-loader.ts）→ 未出现在 diff
- **判定：PASS**

## 3. cs-4.md acceptance 与「行为契约」逐条核对

| acceptance / 契约 | 证据 | 判定 |
|---|---|---|
| 全绿 / 0 fail / typecheck 0 错 | 见 §1 | PASS |
| 新增 `credential-loader.ts`，导出 `CredentialLoader`（+工厂） | 文件存在；`export class CredentialLoader`、`export function createCredentialLoader` | PASS |
| `Channel.initSession` 为委托；实现体移出 | `channel.ts:169-170` = `return this.credentialLoader.ensureSession();`；`rg getSingleUser src/channel/channel.ts` 无命中 | PASS |
| `poller.ensureSession` 指向 `credentialLoader.ensureSession` | `channel.ts:120` = `ensureSession: () => this.credentialLoader.ensureSession()`；`rg this\.initSession src/channel/channel.ts` 无命中 | PASS |
| 顺序：先 credentials，**仅拿到**才读 contextToken | loader 代码；新用例 1 `expect(getSingleUserContextToken).not.toHaveBeenCalled()` | PASS |
| 无 credentials → error + false + state 不变 | `logger.error("No logged in account found")`、`return false`；用例 1 断言 error 次数/参数、state 三字段 `toBeNull` | PASS |
| 有 credentials → 写 userId/accountId/contextToken | 用例 2/3 断言精确值 | PASS |
| 无 contextToken → warn + 仍 true | `logger.warn("No context token found, replies may fail")`、`return true`；用例 3 | PASS |
| debug 文案 `Single user initialized: userId=..., contextToken=present\|MISSING` | 用例 2/3 `toHaveBeenCalledWith` 精确字符串 | PASS |
| 返回值：有凭证 true / 无 false | 用例 1 = `toBe(false)`，用例 2/3 = `toBe(true)` | PASS |
| `Channel` 其余公共 API/文案/持久化/端口签名不变 | 见 §6、§8；`saveContextToken`/`loadSyncCursor`/`saveSyncCursor` 保留 | PASS |

**判定：PASS**

## 4. credential-loader.ts 独立性与依赖方向

- 存在，导出：`CredentialLoader`（class）、`createCredentialLoader`（factory）、`CredentialLoaderDeps`。
- imports 仅 3 条（逐字）：
  ```
  import * as storage from "../storage/state.js";
  import type { ChannelState } from "./state.js";
  import type { PluginLogger } from "../shared/logger.js";
  ```
  → 仅允许的 `./state` / `../storage/state` / `../shared/logger`，import 均为 `type`（无编排/适配/vendor 依赖）。**PASS**

## 5. initSession 委托 + 实现体移除

`src/channel/channel.ts:169-171`：
```ts
async initSession(): Promise<boolean> {
  return this.credentialLoader.ensureSession();
}
```
签名 `(): Promise<boolean>` 未变；`rg "getSingleUser" src/channel/channel.ts` 无命中（内联实现体已彻底移出）。**PASS**

## 6. poller.ensureSession 不再回指 Channel

`src/channel/channel.ts:120` = `ensureSession: () => this.credentialLoader.ensureSession()`。
`rg "this\.initSession" src/channel/channel.ts` → 无命中。
`PollingLoopDeps.ensureSession(): Promise<boolean>`（`polling.ts:33`）签名未变，loader.ensureSession 返回 `Promise<boolean>` 兼容。**PASS**

## 7. 行为契约「逐字等价」（字节级验证）

抽取原 `Channel.initSession` 方法体与新 `CredentialLoader.ensureSession` 方法体做字节 diff：

```
$ git show dev:src/channel/channel.ts | sed -n '/async initSession/,/^  }$/p' | sed '1d;$d' > old
$ sed -n '/async ensureSession/,/^  }$/p' src/channel/credential-loader.ts | sed '1d;$d' > new
$ diff old new
(无差异)
IDENTICAL_BODIES
sha256(old) = cd68ffad5390e40a2a1a39edeb6b1847cb33f586a6286044330744c424057a35
sha256(new) = cd68ffad5390e40a2a1a39edeb6b1847cb33f586a6286044330744c424057a35
```

方法体逐字节一致（含顺序、短路、日志文案、返回值）。**PASS**

## 8. Channel 其余公共方法 / 四个窄接口

- `rg` 枚举 `Channel` 公共方法，dev 与 HEAD 签名集合完全一致（仅因新增 2 行 import 导致行号位移，签名文本无差异）：`setHost/setNotifier/setConfig/getTerminalProcessing/setTerminalProcessing/initSession/stopPolling/startPolling/handleMessage/triggerAi/onAiDone/getTypingTicket/sendTypingStatus/startTyping/stopTyping/sendText/sendFile/sendReply/getCurrentRequestId/isRequestProcessed/markRequestProcessed/reset` 全部保留，`initSession` 签名不变。
- 四个窄接口（`WechatOutbound` @ `src/ports/outbound.ts`、`WechatMedia` @ `src/ports/media.ts`、`WechatInbound` @ `src/ports/inbound.ts`、`WechatAuth` @ `src/ports/auth.ts`）：`src/ports/**` 零 diff，冻结测试 `tests/unit/adapters.test.ts`（"端口冻结：…"）全 pass。
- `ChannelPorts` / `ChannelDeps` 接口体未改（仅行号位移）。**PASS**

## 9. tests/ diff 审计（迁移 / 被蕴含 / 失效）+ 断言强度抽查

- `git diff dev...HEAD --name-only -- tests/` 唯一结果 = **新增** `tests/channel/credential-loader.test.ts`（148 行）。
- `git diff dev...HEAD -- tests/channel/channel.test.ts` = 0 行（**既有用例零修改、零删除**）。
- `--diff-filter=D` 删除文件 = 无。
- 故 ledger「既有用例零修改/零删除/零削弱」成立。
- 新增 4 用例（28 expect）覆盖 test-plan：无凭证 false/error/state 不变/**短路** ✓；有凭证+有 token ✓；有凭证+无 token（warn/MISSING/contextToken=null）✓；工厂 ✓。

**断言强度抽查（≥2 条）：**
- 用例 1：`toBe(false)` / `toHaveBeenCalledTimes(1)` / `toHaveBeenCalledWith("No logged in account found")` / `not.toHaveBeenCalled()` / 三字段 `toBeNull()` —— 精确值+精确次数，含短路语义，未削弱。
- 用例 2：`toBe(true)` / `toBe("U1")` / `toBe("acc1")` / `toBe("CTX-1")` / `toHaveBeenCalledTimes(1)` / `not.toHaveBeenCalled()` / `toHaveBeenCalledWith("Single user initialized: userId=U1, contextToken=present")` —— 全文精确匹配。
- 弱断言扫描 `toBeTruthy|toBeFalsy|toBeDefined|toBeGreaterThan|toBeLessThan|not.toThrow` → 0 命中。

**判定：PASS**（备注见 §12 计数笔误）

## 10. src↔tests 交叉核对

- `credential-loader` 新行为 → 有独立用例 `tests/channel/credential-loader.test.ts`（4/4 pass，单独运行验证通过，见 §1 与下方）。
- `channel.test.ts` 的 initSession 用例仍覆盖委托路径：`await channel.initSession()` 仍被用作 setup（channel.test.ts 12 处实际调用 + 1 处注释；另有 `tests/integration/channel-flow.test.ts` 3 处），随后断言依赖 state 的行为，如 "sendReply 凭证就绪：正常走底层发送" 依赖 initSession 写入 contextToken、D16 typing-ticket 用例依赖 contextToken。
- 单独运行新文件：
  ```
  $ bun test --isolate tests/channel/credential-loader.test.ts
  4 pass / 0 fail / 28 expect() calls
  ```
- `bun test --isolate` 全程通过，证明 `mock.module(storage/state.js)` 未污染 channel.test.ts 的真实 storage 路径。**PASS**

## 11. vendor 零 diff / 无新依赖

- `git diff dev...HEAD -- api/ auth/ cdn/ media/ messaging/ util/ types/*.d.ts` → 空。
- `git diff dev...HEAD -- package.json bun.lock` → 空；`git show HEAD -- package.json bun.lock` 无输出。**PASS**

## 12. 提交原子性 / message / 未 push

- `git log dev..HEAD` 仅 1 个提交：`0e34493 refactor(channel): 抽取凭证加载为 CredentialLoader 协作类`。
- 该提交恰好含 3 文件（channel.ts + credential-loader.ts + 新测试），单一逻辑，无中间不可编译状态。message 前缀符合 `refactor(channel): ...`。**PASS**
- 未 push：`git branch -r --contains HEAD` 为空；`git ls-remote --heads origin refactor/cs-4-credential-loader` 无输出（远端无该分支）；工作树 clean，未切分支。**PASS**

---

## 附：备注（不影响验收）

1. **ledger 计数笔误（轻微）**：`cs-4.result.md` 与任务书写「channel.test.ts 有 14 处 `channel.initSession()`」。实际 `grep -o initSession tests/channel/channel.test.ts | wc -l` = 13，其中 1 处为注释（`// 未 initSession…`，第 273 行），实际调用 **12 处**；跨 tests/ 共 15 处实际调用（channel.test.ts 12 + integration 3）。结论方向不变：`initSession` 确实被大量用作 setup，保留公共委托是必要且正确的；仅计数描述不精确，不构成行为/覆盖缺陷。
2. 未发现任何越界、断言削弱、vendor/依赖改动或 push。

## 最终判定：**PASS**
