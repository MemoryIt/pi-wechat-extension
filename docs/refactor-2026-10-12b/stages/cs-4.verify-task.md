# Verify: CS-4 凭证加载抽取

base-branch: refactor/cs-4-credential-loader
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{credential-loader,channel}.ts`、`tests/channel/**`）
- [ ] 逐条核对 `cs-4.md` 的 acceptance 与「行为契约」
- [ ] 新增 `src/channel/credential-loader.ts` 存在，导出 `CredentialLoader`（及可选工厂）；
      仅依赖 `./state`、`../storage/state`、`../shared/logger`（不引入编排依赖）
- [ ] `Channel.initSession()` 为委托（`return this.credentialLoader.ensureSession()`），签名不变；
      Channel 内已无内联的凭证读取实现体
- [ ] `poller.ensureSession` 指向 `credentialLoader.ensureSession`（`rg` 确认不再 `this.initSession`）
- [ ] 行为契约逐字等价：
      仅在拿到 credentials 时才读 contextToken；无凭证 → error + false + state 不变；
      有凭证 → 写 userId/accountId/contextToken；无 token → warn + true；
      debug 文案 `Single user initialized: userId=..., contextToken=present|MISSING`
- [ ] `Channel` 其余公共方法与四个窄接口契约不变
- [ ] **审计 tests/** 的 diff**：每个删除/修改用例都能按 ledger 对应到「迁移 / 被蕴含 / 失效」；
      抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：`credential-loader` 的新行为有独立用例；`channel.test.ts` 的 initSession 用例仍覆盖委托路径
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-4.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-4-verify`
