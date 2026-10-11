# Verify Report: PA-1（Ports 接口定义，零行为变化）

- task: pa-1
- base-branch: `dev`
- verified-branch: `refactor/pa-1-ports` @ `8b100e88f00ad5905c5c957ef75721428f8a2233`
- merge-base(dev, HEAD): `bb88b231a8d805c508353ac4e6e3c66be3a50348`
- mode: 只读（未修改代码、未提交、未 push）
- verdict: **PASS**

## 结论

PA-1 全部 acceptance 通过。改动严格限定为 `src/ports/*` 纯声明新增（6 文件）+
`tests/engine/router.test.ts` 的 import 指向调整（2 行），无任何 engine/bridge 行为逻辑改动，
测试 93 pass / 12 files / 0 fail，未低于基线且无新增/删除/重命名用例。

## 证据（命令输出）

### 1. install / typecheck / test 全绿
```
$ bun install --frozen-lockfile
bun install v1.4.2 (744846f84)
Checked 131 installs across 139 packages (no changes) [5.00ms]

$ bun run typecheck
$ tsc --noEmit
(exit 0，无输出)

$ bun run test
 93 pass
 0 fail
 252 expect() calls
Ran 93 tests across 12 files. [690.00ms]
```
- ✅ 三个命令全部成功（exit 0）。

### 2. 测试数 ≥ 基线
- 基线：93 pass / 12 files / 0 fail
- 实测：93 pass / 12 files / 0 fail
- ✅ 等于基线（本阶段只调整 import，未增删用例）。与 result 声明的
  `test-changes: 新增 0，重命名 0，删除 0` 一致。

### 3. `git diff dev...HEAD --stat` 未越界
```
 src/ports/auth.ts           | 48 +++++++++++++++++++++++++++++++++++++++++++++
 src/ports/inbound.ts        | 30 ++++++++++++++++++++++++++++
 src/ports/media.ts          | 44 +++++++++++++++++++++++++++++++++++++++++
 src/ports/outbound.ts       | 25 +++++++++++++++++++++++++
 src/ports/pi-host.ts        | 18 +++++++++++++++++
 src/ports/types.ts          | 12 ++++++++++++
 tests/engine/router.test.ts |  4 ++--
 7 files changed, 179 insertions(+), 2 deletions(-)
```
- ✅ 仅 `src/ports/*` 新增 + `tests/engine/router.test.ts` 修改。
- `git diff dev...HEAD -- src/engine src/bridge` → 空。
- `git diff dev...HEAD -- package.json bun.lock ...` → 空（无新依赖）。
- `git diff dev...HEAD --name-only -- tests` → 仅 `tests/engine/router.test.ts`。

### 4. 逐条核对 pa-1.md acceptance
- [x] `bun run typecheck && bun run test` 全绿，既有用例数不减少（93 ≥ 93）。
- [x] 新增 `src/ports/*` 接口；无运行时逻辑（仅 interface/type/常量）。
- [x] `rg "api/types" src/ports` 仅命中 `src/ports/types.ts`。
- [x] engine/bridge 调用逻辑与运行时行为未改变（diff 为空）。
- [x] `tests/engine/router.test.ts` 通过（全套 93 pass）。
- [x] 提交原子、message 规范（feat(ports)/test(router) 两个逻辑独立 commit）。

### 5. `rg "api/types" src/ports` 单一命中
```
src/ports/types.ts:4: * 端口层唯一允许直接依赖 `api/types` 的文件 ...
src/ports/types.ts:11:export type { WeixinMessage, MessageItem } from "../../api/types.js";
src/ports/types.ts:12:export { MessageItemType } from "../../api/types.js";
```
- ✅ 仅 `ports/types.ts`（3 处同文件，含注释与两行 re-export）。

### 6. `src/ports/*` 无运行时逻辑
- 全量 `rg` 运行时关键字仅命中 `media.ts:21` 的类型签名 `) => Promise<{ path: string }>;`
  （`SaveMediaFn` 类型别名，非运行时逻辑）。
- `types.ts` 的 `MessageItemType` 为 `api/types.ts` 中的 `export const`（常量对象），
  符合「只含 interface/type/常量」。
- 6 文件均为 `interface` / `type` / `export type` / `export const`（常量转发），无函数/类/副作用。

### 7. engine/bridge 行为逻辑未改
- `git diff dev...HEAD -- src/engine src/bridge` 输出为空。
- `PiHost`（`src/ports/pi-host.ts`）与现 `WechatHost`（`src/engine/wechat.ts:36-43`）逐字段结构等价
  （appendEntry / sendUserMessage / sendMessage 及选项联合类型完全一致）。

### 8. 关键回归语义仍被断言覆盖
- `tests/engine/engine.test.ts` 在本分支 **diff 为空**，未被删改。
- 抽查 D3/D9/D13/D16 仍在：
  - `D3 目标：重复 startPolling 不应并发两条轮询循环`
  - `D9 限制说明 ...` / `D9 目标：stopPolling 后 startPolling 应在 300ms 内 resolve`
  - `D13 目标：同一毫秒内的 requestId 应保持唯一`
  - `D16 目标：contextToken 变化后应重新获取 typing ticket` / `D16b ... unref`
- ✅ 覆盖未因本阶段退化。

## 备注（非阻塞）
- result 中记录的未决项（`SaveMediaFn` 三参 vs 现有五参、`download` 返回收敛为 `{path}|null`）
  属于 S2 adapter 适配事项，本阶段仅声明端口，不违反 PA-1 的「零行为变化」约束。
