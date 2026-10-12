status: done
branch: refactor/rf-6-channel-slim
commits:
- ed6c0f9 refactor(channel): requestId 追踪抽到 RequestIdGenerator，ChannelState 收敛
- 093cf86 refactor(bridge): 以窄接口取代对具体 Channel 的依赖

tests: bun install --frozen-lockfile && bun run typecheck && bun run test => pass
  （167 pass / 19 files / 0 fail / 478 expect calls；基线 163 / 18 / 0，新增 4 例；typecheck 零错误）

test-changes: 新增 4，修改 1，删除 0
  - 新增 tests/channel/request-id.test.ts（4 例，直接测 RequestIdGenerator，now 用本地时间构造避免时区依赖）：
    同毫秒连续两次 id 不同且后缀 000/001 递增；同毫秒多次序号递增且唯一；
    now 变化序号归零；格式 = 15 位时间戳 + 3 位序号（总长 18，精确前缀 260102030405678）。
  - 修改 tests/unit/channel-state.test.ts：删除对已移除字段 lastRequestIdMs / requestIdSeq 的 8 处断言
    （默认值 / 读写 / resetSession / 幂等等用例的断言本身不削弱，仅同步迁移，其不变量由 request-id.test.ts 覆盖），
    其余语义（凭证 / 终端标志默认、getCredentials / getOpts、resetSession 保留 config/host/notifier）不变。
  - D13（tests/channel/channel.test.ts）零改动、仍通过（走私有 generateRequestId() 委托）。

scope-check: 未越界。`git diff dev...HEAD --stat` 仅 7 个文件：
  - src/channel/request-id.ts（新增，+35：RequestIdGenerator）
  - src/channel/channel.ts（-9/+4：删 configure() 与 cleanupProcessedRequests()；新增
    private readonly requestId = new RequestIdGenerator()；generateRequestId() 委托 next()；
    公共 API 分组注释；移除不再使用的 formatTimestamp import；reset 注释去「请求追踪」）
  - src/channel/state.ts（删 lastRequestIdMs / requestIdSeq 字段及其 resetSession 重置；文件头注释更新）
  - src/bridge/events.ts（新增 BridgeChannel 窄接口，BridgeDeps.channel 改型；删 channel/channel import）
  - src/bridge/tool-send-file.ts（createSendFileTool 参数改窄接口 { sendFile }；新增 SendFileChannel）
  - tests/channel/request-id.test.ts（新增）、tests/unit/channel-state.test.ts（同步迁移）
  核对为空的项：
  - vendor（api/auth/cdn/media/messaging/util、types/*.d.ts）零 diff；package.json / bun.lock 零 diff；未新增依赖。
  - src/ports/**、src/adapters/**、src/application/**、src/channel/ 下 polls/queue/router/media-store/typing/sender
    零 diff；src/index.ts 零 diff（具体 Channel 结构化满足窄接口，类型层面自动适配，无需改动）。
  - 未 push（origin/dev 无新提交）；dev 未改（dev 仍为 bc41b2f，是分支起点）；当前分支 refactor/rf-6-channel-slim。

acceptance:
  - [x] `bun install --frozen-lockfile && bun run typecheck && bun run test` 全绿，167 pass / 19 files ≥ 163 / 18；typecheck 零错误
  - [x] `rg "configure\(|cleanupProcessedRequests" src/channel/channel.ts tests` 无命中
  - [x] `rg "lastRequestIdMs|requestIdSeq" src tests` 无命中
  - [x] src/channel/request-id.ts 新增 RequestIdGenerator；channel.ts 持有并委托（private readonly requestId，
        generateRequestId() → this.requestId.next()，方法名与签名不变）
  - [x] `rg "channel/channel" src/bridge` 无命中（bridge 只用 BridgeChannel / SendFileChannel 窄接口，
        Notifier 为 type-only import 自 channel/state.js）
  - [x] D13 既有用例未改动（git diff 确认 tests/channel/channel.test.ts 零 diff）且通过
  - [x] `git diff dev...HEAD --stat` 仅限 src/channel/{channel,state,request-id}.ts、
        src/bridge/{events,tool-send-file}.ts、tests/**（index.ts 无需改动）
  - [x] 提交原子（两个逻辑 commit：channel 收敛先行、bridge 接线随后，每个 commit 均 typecheck/test 全绿）、
        message 规范（refactor(channel): … / refactor(bridge): …）

invariants:
  - [x] ChannelState 字段收敛为 accountId / userId / contextToken / config / host / notifier /
        isTerminalMessageProcessing；resetSession() 清空凭证 + 终端标志，保留 config/host/notifier
  - [x] Channel.generateRequestId() 仍是私有、签名不变；产出格式 YYMMDDHHMMSSmmm + 3 位同毫秒序号；
        同一实例同毫秒唯一（D13 与 request-id 用例共同覆盖）
  - [x] Channel 其余公共方法签名与行为不变；连接状态 getter 仍委托 PollingLoop
  - [x] bridge/** 不再 import ../channel/channel.js（改为窄接口类型）
  - [x] 公共对外行为 / 文案 / 持久化 / 端口签名不变；连接状态真相源仍在 PollingLoop

notes: |
  - 行为等价性说明：迁移前 reset() 经 ChannelState.resetSession() 把 lastRequestIdMs/requestIdSeq 复位；
    现在 RequestIdGenerator 持有于 Channel 自身（非 ChannelState），reset() 不再复位其序号。
    可观测行为不变：requestId 只要求「同毫秒唯一」，序号不复位不产生重复或格式变化
    （同一毫秒内连发才递增，实际毫秒几乎必然不同）；任务书 scope 亦未要求 generator 复位。
  - index.ts 零 diff 的原因：registerBridge 的 BridgeDeps.channel 与新 createSendFileTool 参数均为
    结构型窄接口，具体 Channel 天然满足（setNotifier/setTerminalProcessing/startTyping/stopTyping/sendFile），
    无任何显式改动必要；类型检查证明成立。允许文件集合内该文件为 0 变化，不越界。
  - tests/unit/channel-state.test.ts 的删除属「已删字段断言」的同步迁移（任务书 forbidden 明确豁免并
    要求在 result 说明）：字段已不存在，断言无法保留；迁移后其余断言未削弱，等价 Uniqueness 由新增
    request-id.test.ts 覆盖。
  - 未决项 / 需 human 决策：无。