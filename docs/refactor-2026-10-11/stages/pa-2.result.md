status: done
branch: refactor/pa-2-adapters
commits:
- 5d56132768a7eec0adba3cb2044f8fc65cafea82 refactor(shared): 建立 redact/file-logger 再导出边界并收口自写 import
- f039c372653134730a5bfe839fb8c20eb0d0f653 feat(adapters): 新增 4 个微信侧 adapter 薄包装
- 5d4388eaf7ad20ef46f7d746c9ec0e02aeaac567 test(adapters): 新增 adapter 基线用例
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（114 pass / 13 files / 0 fail）
test-changes: 新增 21（tests/unit/adapters.test.ts），重命名 0，删除 0。基线 93 → 114，文件 12 → 13。理由：为 4 个 adapter 建立回归基线，覆盖 inbound 映射、outbound 发送/缓存、media 回调适配与路径挑选、auth 字段映射。
scope-check: 未越界。改动清单：
  - 新增 src/adapters/{inbound,outbound,media,auth}.ts
  - 新增 src/shared/{redact,file-logger}.ts（薄再导出边界）
  - 修改 src/shared/logger.ts（redact import 改 ./redact.js）
  - 修改 src/bridge/login.ts（redact import 改 ../shared/redact.js，逻辑未动）
  - 修改 src/storage/state.ts（logger import 改 ../shared/file-logger.js，逻辑未动）
  - 增量修改 src/ports/types.ts（仅新增 WechatCredentials）
  - 新增 tests/unit/adapters.test.ts
  - vendor 目录（api/ auth/ cdn/ media/ messaging/ util/ types/）diff vs dev 为空
  - src/engine/*、src/bridge/{events,commands,tool-send-file}.ts diff vs dev 为空
  - adapter 未被 engine/bridge 接入：`rg "adapters/(inbound|outbound|media|auth)" src --glob '!src/adapters/**'` 无命中
  - `rg "util/(redact|logger)" src` 仅命中 src/shared/redact.ts 与 src/shared/file-logger.ts
notes: |
  - 实现要点：
    * inbound：getUpdates({get_updates_buf, baseUrl, token, timeoutMs}) → { messages: msgs ?? [], cursor: get_updates_buf ?? "" }。
    * outbound：sendText/sendFile 凭证缺失时抛 "Single user not initialized"（与 engine/sender.ts 现行为一致）；
      sendFile 用固定 CDN 基址 https://novac2c.cdn.weixin.qq.com/c2c（同 sender.ts）；
      getTypingTicket 60s TTL + contextToken 绑定，getConfig ret===0 才缓存，凭证缺失/失败返回 null；
      sendTyping 取 ticket 后发送，无 ticket 时记录并返回（不抛）；getConfig/sendTyping 报错信息含 "ticket" 时清缓存。
    * media：端口 3 参 saveMedia 适配为 vendor 5 参回调（忽略 subdir/maxBytes），
      从 decryptedPicPath → decryptedVoicePath → decryptedFilePath → decryptedVideoPath 取首个非空 → { path }，否则 null；
      label 缺省为 "media"；log/errLog 由构造注入，默认 no-op。
    * auth：startQr/waitForLogin 字段对齐端口；botType 缺省时采用 DEFAULT_ILINK_BOT_TYPE（"3"），
      与 vendor login-qr 内部默认一致，不改变外部行为。
  - 未决项 / 需 S3 决策：inbound 在响应缺少 get_updates_buf 时回落为 ""（薄映射），
    旧 PollingLoop 语义是 `?? 旧 cursor`。因本阶段未接入 engine，行为不变；S3 接入时如需保留旧 cursor，
    需在 channel/engine 侧处理或调整 adapter 回落策略。
  - tests/setup/mocks.ts 未改动：file-logger 再导出仍命中被 mock 的 util/logger.js（93 基线用例全绿验证）。
  - 无新增依赖；未 push；未改 base 分支（dev 为 HEAD 祖先）。
