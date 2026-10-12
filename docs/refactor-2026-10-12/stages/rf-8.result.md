# RF-8 修正结果

status: **DONE**（修正上一轮独立验证 FAIL 的 6 项阻塞 + 1 项次要问题，全部完成）
branch: `refactor/rf-8-docs`
commit: `f32bb20` docs(arch): align bridge dependency edges with real code
base: dev（`0ecda12`，本分支未改 dev）
改动范围: 仅 `docs/**`（6 个文件，12 insertions / 15 deletions），`src/`、`tests/`、vendor、lockfile 零改动；未 push。

## 依据

独立验证报告 `/tmp/pi-tasks/rf-8.verify-result.md` §9「建议的最小修复」（共 7 项，全部执行）。
真实依赖以代码为准：`src/bridge/*` 只 import `../application/*`、`../channel/state.js`（仅 `Notifier` 类型）与 `../shared/logger.js`，不 import `ports/*`、`storage/*`；`WechatAuth` 由 `src/application/session.ts`（`SessionService`）与 `index` 使用。

## 逐项修正

1. **`docs/ARCHITECTURE.md` §2 依赖方向**（对应报告 §9-1）
   - 删除错误依赖边 `bridge ──→ ports/*（WechatAuth）` 与
     `bridge ──→ storage/*（凭证 / 账号）`（后者为 RF-8 新增、代码不存在；前者为 dev 遗留、bridge/login.ts 已删除）。
   - bridge 行现仅保留 `bridge ──→ application（事件 → 用例委托）` 与
     `bridge ──→ channel（窄接口：BridgeChannel）` 两条真实直接依赖。

2. **`docs/c4/03-components.puml`**（报告 §9-2）
   - 删除 `Rel(bridge, ports, "WechatAuth（类型）")` 与 `Rel(bridge, storage, "凭证 / 账号")` 两条边。
   - 约束 note 中 bridge 依赖由 `bridge → application ... / channel（窄接口）/ ports / storage`
     修正为 `bridge → application（事件翻译→用例委托）/ channel（窄接口）/ shared`，
     与「bridge 只做事件→用例委托」的 Component 职责描述一致，消除自相矛盾。

3. **`docs/refactor-2026-10-12/README.md`**（报告 §9-3）
   - 「依赖方向」行 `bridge → application（事件→用例委托）/ channel（BridgeChannel 窄接口）/ ports / storage`
     修正为 `bridge → application（事件→用例委托）/ channel（BridgeChannel 窄接口）/ shared`。

4. **`docs/c4/03a-channel.puml`**（报告 §9-4）
   - ScopeNote：`WechatAuth` 使用方由「bridge / index」改为「**application / index**」。

5. **`docs/c4/03b-ports-adapters.puml`**（报告 §9-5）
   - 调用方 Component 名与 BoundaryNote 描述由「Channel / Bridge / Application」改为「**Channel / Application**」
     （bridge 已不 import 任何 `src/ports/*`）。

6. **`docs/c4/04-class-channel.puml`**（报告 §9-6）
   - `WechatAuth` 附注：「index 构造 createWechatAuth() 并交给 bridge（login）」改为「交给
     **application/session（登录用例）**」（bridge/login.ts 已删除）。

7. **`docs/ARCHITECTURE.md` 章节号跳号**（报告 §9-7，次要）
   - 原 `### 4.8` 直接跳到 `### 4.10`（缺 4.9）：将 4.10/4.11/4.12/4.13/4.14 顺号为
     **4.9/4.10/4.11/4.12/4.13**，并同步更新第 8 节交叉引用「四个窄接口矩阵（见 4.11）」→「（见 4.10）」。
   - 现在第 4 节编号连续：4.1–4.13。

## 范围与提交

- `git diff dev...HEAD --name-only`：仅 `docs/ARCHITECTURE.md`、`docs/c4/{03,03a,03b,04}*.puml`、
  `docs/refactor-2026-10-12/README.md`（本次修正 6 文件）＋上一轮 docs 成果；`src/`、`tests/`、
  `package.json`、`bun.lock`、vendor、历史档案 `docs/refactor-2026-10-11/**` 零改动。
- 原子提交：单 commit `f32bb20`，Conventional Commits 格式，message 含逐项说明。
- 未 push：`git ls-remote --heads origin` 无 `refactor/rf-8-docs`。
## 追加修正（主 Agent 顺手，验证 Agent 二轮 §9 非阻塞项）
- docs/c4/04-class-channel.puml：交叉引用 §4.11 → §4.10（重编号后窄接口面章节）。
- docs/ARCHITECTURE.md：两处相对链接 `../vendor-constraints.md` → `vendor-constraints.md`（同目录）。
- 提交：`docs(arch): fix vendor-constraints links and section cross-ref`。

## S8 时间线（归档注记）
- 首轮实现：`d666130` / `8d194be` / `8a19687` / `8d9eb18`（架构+C4 同步 / E2E 清单 / README 收尾 / 图注）。
- 首轮独立验证 **FAIL**：架构文档与多张 C4 图存在 `bridge → ports/storage` 错误依赖边，及 `WechatAuth` 归属的过时表述。
- 修正：`f32bb20`（按验证报告 §9 逐条修正 7 项）。
- 收尾：`63589b3`（修 `docs/ARCHITECTURE.md` 的 `vendor-constraints.md` 相对链接、`docs/c4/04-class-channel.puml` 的 `§4.11→§4.10` 交叉引用）。
- 最终独立验证 **PASS**（171 pass / 20 files / 0 fail，纯文档；`src/`、`tests/`、vendor、lockfile 零改动）。
- 注：本轮首轮实现报告与首轮 FAIL 报告属过程中间产物，已被最终版覆盖，未纳入归档；S8 内容以最终 `dev...refactor/rf-8-docs` diff 与本文档为准。
