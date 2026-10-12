# Verify: CS-5 入站处理器抽取 + 打破回调闭环

base-branch: refactor/cs-5-inbound-handler
mode: 只读（禁止修改代码/提交/push；允许 `bun install` 与测试，只写本报告）

check:
- [ ] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿、0 fail（贴计数；
      允许低于 baseline，不以数量为通过条件）
- [ ] `git diff dev...HEAD --stat` 未越界（只应有 `src/channel/{inbound-handler,channel}.ts`、`tests/channel/**`）
- [ ] 逐条核对 `cs-5.md` 的 acceptance 与「行为契约」
- [ ] 新增 `src/channel/inbound-handler.ts` 存在，导出 `InboundHandler`（及工厂）；
      仅依赖 `ports/types`、`shared/types`、`storage/state`、`./state`、`./request-id`、`shared/logger`
- [ ] **两个 poller 回调都不再指回 Channel**：`ensureSession` 指向 `credentialLoader`（cs-4），
      `onMessage` 指向 `inboundHandler.handle`（`rg` 确认 Channel 构造中无 `this.handleMessage`）
- [ ] `Channel.handleMessage` / `triggerAi` 为委托，签名不变；`rg` 确认 `Channel` 无 `generateRequestId` 与 `requestId` 字段
- [ ] 行为契约逐字等价：先生成 requestId；contextToken 变化时 debug+写 state+`invalidateTicket`+
      条件 `saveContextToken(accountId, userId, {displayName:userId, contextToken, lastMessageAt})`；
      无变化/无 token 时无副作用；最终 `dispatch(msg, requestId, opts)`
- [ ] `Channel` 其余公共方法与四个窄接口契约不变
- [ ] **审计 tests/** 的 diff**：每个删除/修改用例都能按 ledger 对应到「迁移 / 被蕴含 / 失效」；
      D13 若删除，确认其不变量确由 `tests/channel/request-id.test.ts` 覆盖（同一毫秒唯一）；
      抽查 ≥2 条确认断言强度未削弱
- [ ] **交叉核对 src↔tests**：`inbound-handler` 新行为有独立用例；`channel.test.ts` 的
      handleMessage/triggerAi 用例仍覆盖委托路径
- [ ] vendor 零 diff、无新依赖（`package.json` / `bun.lock`）
- [ ] 提交原子、message 规范；未 push

verdict-report: 写 `/tmp/pi-tasks/cs-5.verify-result.md`（PASS/FAIL + 证据/命令输出），执行：

`tmux wait-for -S task-cs-5-verify`
