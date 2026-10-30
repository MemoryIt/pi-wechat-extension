status: done
branch: refactor/pa-1-ports
commits:
- fc9a26f7a58aefe1522d375d37f57ba26a2a7892 feat(ports): 新增 Ports & Adapters 端口接口与类型边界
- 8b100e88f00ad5905c5c957ef75721428f8a2233 test(router): WechatHost import 指向 ports/pi-host
tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass（93 pass / 12 files / 0 fail）
test-changes: 新增 0，重命名 0，删除 0；仅 tests/engine/router.test.ts 的 `WechatHost` 类型 import 改为 `PiHost`（结构等价的端口类型），断言与用例数均未变。
scope-check: 未越界。改动目录：新增 `src/ports/`（auth.ts / inbound.ts / media.ts / outbound.ts / pi-host.ts / types.ts），修改 `tests/engine/router.test.ts`（仅 import）。`src/engine/`、`src/bridge/` diff 为空。
notes: |
  - 端口清单与建议一致，仅做极薄声明（interface/type/单个常量 re-export），无运行时逻辑：
    WechatInbound.getUpdates、WechatOutbound（sendText/sendFile/sendTyping/getTypingTicket）、
    WechatMedia.download + SaveMediaFn、WechatAuth（startQr/waitForLogin）、PiHost、
    types.ts（唯一 re-export WeixinMessage/MessageItem/MessageItemType 的边界）。
  - 类型边界校验：`rg "api/types" src/ports` 仅命中 `src/ports/types.ts`。
  - 后端 `WechatHost`（src/engine/wechat.ts）本阶段按 scope 未改动，PiHost 与其结构完全一致，
    后续 S2/S3 再做 adapter 包装与 engine 改用端口。
  - 未决项：WechatMedia.SaveMediaFn 采用任务书建议的三参简化签名（buffer/contentType?/originalFilename?）；
    现 `media/media-download.ts` 的 SaveMediaFn 为五参（含 subdir/maxBytes），S2 实现 adapter 时需做形参适配
    （落盘策略按任务书要求保留在 channel 侧回调）。WechatMedia.download 的返回亦收敛为 `{ path } | null`，
    而现 `downloadMediaFromItem` 返回 `WeixinInboundMediaOpts`，适配时需按优先级挑选单一路径。
  - 无新增依赖；未 push；未改 base 分支。
