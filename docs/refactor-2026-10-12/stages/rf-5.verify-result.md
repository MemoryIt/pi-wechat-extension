status: PASS
task: RF-5 adapters ACL 注释 + vendor 约束文档 + 端口冻结
mode: 只读复验（未修改代码/未提交/未 push；仅 `bun install` 与测试）
verified-commit: 643596e2c55bfaa48b32181aa5b049042be1f041
branch: refactor/rf-5-acl（worktree 处于 detached HEAD，指向待验提交）
base: dev（merge-base = 1c9dd8866d6ec2c0a6bd7d7a2638fc23b088d819，为 HEAD 直接祖先）
verifier: independent

summary: |
  复验通过。逐条核对 rf-5.verify-task.md 的 10 项 check，全部满足。
  工作树 clean；仅 1 个原子提交；adapter 改动为纯注释新增（numstat 删除 0）；
  vendor / ports / channel / bridge / application / storage / shared 零 diff；
  无新依赖；未 push。测试 163 pass / 18 files / 0 fail，与 rf-5.result.md 声明一致。

evidence:

check-1: `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿
  install: "bun install v1.4.2 / 130 packages installed [849.00ms]"（exit 0）
  typecheck: `$ tsc --noEmit` 无输出（零错误，exit 0）
  test: 末尾统计
    "163 pass / 0 fail / 472 expect() calls / Ran 163 tests across 18 files. [794.00ms]"
  verdict: PASS

check-2: 测试数 ≥ 基线且与 rf-5.result.md 一致
  基线（rf-5.md / rf-4.result.md）: 160 pass / 18 files / 0 fail
  实测: 163 pass / 18 files / 0 fail / 472 expect calls
  rf-5.result.md 声明: 163 pass / 18 files / 0 fail / 472 expect calls（新增 3 例）
  一致: 是；≥ 基线: 是
  verdict: PASS

check-3: `git diff dev...HEAD --stat` 未越界
  输出（仅允许的 3 类文件）:
    docs/vendor-constraints.md  | 135 +++++
    src/adapters/auth.ts        |  12 ++
    src/adapters/inbound.ts     |  11 ++
    src/adapters/media.ts       |  13 ++
    src/adapters/outbound.ts    |  13 ++
    tests/unit/adapters.test.ts |  57 ++
    6 files changed, 241 insertions(+), 0 deletions(-)
  numstat（全部 deletion = 0）:
    135 0 docs/vendor-constraints.md
     12 0 src/adapters/auth.ts
     11 0 src/adapters/inbound.ts
     13 0 src/adapters/media.ts
     13 0 src/adapters/outbound.ts
     57 0 tests/unit/adapters.test.ts
  verdict: PASS（仅在白名单内）

check-4: docs/vendor-constraints.md 存在且含 6 个章节
  `grep -n '^## ' docs/vendor-constraints.md`:
    6:## 1. 目的与维护规则
    20:## 2. 所有权与目录
    33:## 3. 已知不可动耦合
    95:## 4. 低使用 / 死代码
    106:## 5. 端口冻结与责任边界
    122:## 6. 变更检查清单
  覆盖任务要求：目的/所有权/不可动耦合/低使用死代码/端口冻结/变更清单 全部存在。
  第 3 章含 3.1~3.6 六条已知耦合，均按「位置 / 性质 / 影响 / 应对」展开。
  verdict: PASS

check-5: 4 个 adapter 顶部有 ACL 注释；非注释代码行零改动
  4 个文件均前置新增 `/** ... ACL ... */` 块（auth/inbound/media/outbound）。
  逐行核对 `git diff dev...HEAD -- src/adapters`：
    过滤掉 `+++`、以 `*` 开头的注释行、`/**` 起始行、空行后，
    「新增非注释代码行」= 0（命令输出 "none (all added lines are comments)"）。
  删除行核对：`git diff ... -- src/adapters | grep '^-'` 仅命中 4 条 `--- a/...` 文件头，
    真实删除行 = 0（与 numstat 0 deletion 吻合）。纯新增，无运行时逻辑改动。
  verdict: PASS

check-6: 新增端口冻结用例覆盖要求的参数面
  tests/unit/adapters.test.ts 新增 3 例（+57 行）:
    - "端口冻结：WechatOutbound 方法参数面（sendFile 不得加 to）"
        → sendText.length===1、sendFile.length===1、sendTyping.length===2、getTypingTicket.length===0
    - "端口冻结：WechatMedia / WechatInbound / WechatAuth 方法参数面"
        → media.download.length===2、inbound.getUpdates.length===1、auth.startQr.length===1、auth.waitForLogin.length===1
    - "ACL 契约：vendor 5 参 saveMedia → 端口仅收到 3 参，subdir/maxBytes 不泄漏"
        → vendor 以 5 参 `(Buffer.from("acl"), "image/png", "inbound", 100, "orig.png")` 调用，
          断言 `saveMedia.mock.calls[0].length===3` 且 buffer/contentType/originalFilename 值正确
  三例在 check-1 全量测试中均 pass。
  verdict: PASS

check-7: 端口签名未被改动
  `git diff dev...HEAD --stat -- src/ports src/channel src/bridge src/application src/storage src/shared` → 空。
  即 `src/ports/**` 零 diff，端口签名与 dev 完全相同：
    src/ports/outbound.ts: sendFile(localPath: string): Promise<void>（无 `to`）
    src/ports/media.ts: SaveMediaFn = (buffer, contentType?, originalFilename?)（3 参，未改）
    src/ports/inbound.ts: getUpdates(params)、src/ports/auth.ts: startQr(opts)/waitForLogin(opts)
  verdict: PASS

check-8: 指定目录 diff 为空
  `git diff dev...HEAD --stat -- src/ports src/channel src/bridge src/application src/storage src/shared`
  无任何输出 → 全部为空。
  verdict: PASS

check-9: vendor diff 为空、无新依赖
  `git diff dev...HEAD --stat -- api auth cdn media messaging util 'types/*.d.ts'` → 空。
  `git diff dev...HEAD --stat -- package.json bun.lock bun.lockb` → 空。
  未新增依赖。
  verdict: PASS

check-10: 提交原子、message 规范；未 push
  提交数：dev..HEAD 仅 1 个 commit（HEAD = merge-base 的子提交）:
    643596e2c55bfaa48b32181aa5b049042be1f041
    refactor(adapters): 明确 ACL 边界、vendor 约束文档与端口冻结
    pi-bot <pi-bot@local>
  message 符合 Conventional Commits（type=refactor，scope=adapters，中文摘要）。
  原子性：ACL 注释 + 约束文档 + 冻结测试同属一个「RF-5 边界固化」逻辑，单 commit，可编译/测试通过。
  未 push：`git ls-remote --heads origin refactor/rf-5-acl` 无输出（远端无该分支）。
  `git status --porcelain` 为空（工作树 clean）。
  verdict: PASS

verdict: PASS

notes:
  - rf-5.result.md 位于 /tmp/pi-tasks/rf-5.result.md（非仓库内文件），其声明与实测逐项一致。
  - 本次复验未写入仓库任何文件，未 stage/commit/push；仅本报告位于 /tmp/pi-tasks/rf-5.verify-result.md。
