https://github.com/user-attachments/assets/fdaf0e09-9fa5-491d-8507-464b0a5ec16d
# pi-wechat-extension

微信插件，将微信接入 pi coding agent，实现"微信聊天 → AI 回复"的双向交互。

## 兼容性

| 项目 | 版本 |
|------|------|
| pi | `@earendil-works/pi-coding-agent` 0.85+ |
| Node.js | >= 22 |

> **包作用域**：插件面向 npm 上的 `@earendil-works/pi-coding-agent`（0.85.x）开发，
> 使用其正式类型（`ExtensionAPI` / `ToolDefinition` / `AgentToolResult` 等）。
> 开发依赖同样声明为该包；旧作用域 `@mariozechner/pi-coding-agent` 已不再使用。

## 已实现功能

| 功能 | 说明 | 状态 |
|------|------|------|
| **登录及持久化** | 扫码一次，登录信息持久化保存，下次自动连接 | ✅ |
| **双向消息发送** | 微信发消息 → pi 终端显示；AI 回复 → 微信收到 | ✅ |
| **文件发送** | AI 通过 `send_wechat_file` 工具向微信发送本地文件 | ✅ |
| **运行信息追加** | 文本消息后追加：所在目录、Git 分支、Token 使用、模型信息 | ✅ |




## 依赖与包作用域

- **运行依赖**：`qrcode-terminal`、`@sinclair/typebox`（工具参数 schema）。
- **开发依赖**：`@earendil-works/pi-coding-agent`（SDK 类型与 `getAgentDir()`）、
  `typescript`（`bun run typecheck`）、`@types/node`、`@types/qrcode-terminal`。
- **包作用域统一**：仓库内所有对 pi SDK 的 import 与 `package.json` 声明统一为
  `@earendil-works/pi-coding-agent`；不再引用旧的 `@mariozechner/pi-coding-agent`。

```bash
bun install        # 安装依赖
bun run test       # 运行全套测试
bun run typecheck  # tsc --noEmit 类型检查
```

## 快速开始

### 1. 安装及卸载

```bash
# 推荐安装到某个本地项目（而非全局）
# 进入你的项目目录
cd /path/to/your-project
# 安装到项目级别（关键是加上 -l 或 --local 参数）
pi install -l git:github.com/MemoryIt/pi-wechat-extension
# 验证安装是否成功
# 在项目目录下运行：
pi list
# 应该能看到类似输出：
# Project packages:
#     git:github.com/MemoryIt/pi-wechat-extension
# 卸载项目级安装的扩展（推荐方式）
pi remove -l git:github.com/MemoryIt/pi-wechat-extension
# 或者使用别名（完全等效）
pi uninstall -l git:github.com/MemoryIt/pi-wechat-extension
```

### 2. 登录微信

```
/wechat login
```

终端会显示二维码，使用微信扫描完成登录。

### 3. 开始聊天

登录后自动连接微信。直接通过微信给 bot 发消息，查看AI回复。

## 终端命令

| 命令 | 功能 |
|------|------|
| `/wechat login` | 扫码登录微信 |
| `/wechat logout` | 登出微信并清除凭证 |
| `/wechat status` | 查看连接状态 |
| `/wechat start` | 手动启动轮询 |
| `/wechat stop` | 手动停止轮询 |

### 文件发送工具

pi 可通过 `send_wechat_file` 工具向微信用户发送本地文件：

```typescript
// Tool 定义
{
  name: "send_wechat_file",
  description: "向当前微信用户发送本地文件。必须提供文件的完整绝对路径。",
  parameters: {
    localPath: string  // 必填，文件完整绝对路径
  }
}
```

> **显示名**：微信端以本地文件的文件名（`path.basename(localPath)`）作为显示名，
> 工具不再接受 `fileName` 参数，也无法自定义显示名。

**使用示例**：
```
请把 /Users/mou/code/pi-dev/sample.txt 发送给微信用户
```

## 配置说明

### 配置文件

创建 `~/.pi/agent/wechat/config.json`：

```json
{
  "debug": false,
  "mediaStoragePath": "/custom/path/to/media"
}
```

### 环境变量

| 变量名 | 说明 |
|--------|------|
| `WECHAT_DEBUG` | 调试模式 (`true`/`false`) |
| `WECHAT_MEDIA_PATH` | 媒体文件存储路径 |

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | boolean | `false` | 调试模式 |
| `mediaStoragePath` | string | `{agentDir}/wechat/media` | 媒体文件存储路径 |

**配置优先级**: 环境变量 > config.json > 默认值。环境变量按字段**独立**覆盖：
只显式设置了某个环境变量时，仅覆盖对应字段，config.json 中的其它字段保持生效。

## 工作流程

```
微信发消息 → 长轮询接收 → 消息格式化 → pi.sendUserMessage()
    ↓
AI 在终端生成回复
    ↓
message_start → Typing Keepalive (每8秒刷新)
    ↓
message_end → 停止 Typing
    ↓
agent_settled → 提取本轮最终回复 → 发送至微信
```

> 最终回复在 `agent_settled`（一轮全部结束、不会再有重试/压缩/续跑）时发送，
> 保证只发一次且是最终版本；`agent_end` 仅用于 typing 收敛与终端标志兜底。



## 技术细节

### 单用户模式

插件采用单用户模式设计，简化了多用户场景下的复杂逻辑：

- **固定凭证**：运行时从存储加载唯一账号的登录凭证
- **单队列机制**：消息按接收顺序排队处理
- **requestId 格式**：毫秒级时间戳 `YYMMDDHHMMSSmmm`（15 位）+ 3 位同毫秒序号（共 18 位，保证同毫秒内唯一）

### 持久化存储

```
~/.pi/agent/wechat/
├── accounts.json              # 账号索引
├── config.json                # 插件配置
└── accounts/
    └── {accountId}/
        ├── token.json              # 登录凭证 (chmod 600)
        ├── context-tokens.json     # 用户上下文 tokens
        └── sync.json               # 轮询 sync cursor
```

### 媒体存储结构

```
{mediaStoragePath}/
└── {YY}{WW}/                    # ISO 周文件夹 (如 "2604")
    └── {timestamp}_{uuid8}.{ext}  # 文件 (如 "260421141030123_a1b2c3d4.jpg")
```

### Typing 机制

- `message_start` → 发送 `typing=1` + 启动 8 秒间隔 keepalive
- `message_end` → 停止 keepalive
- `typing_ticket`：从 `getConfig` API 获取，60 秒缓存

### 消息队列机制

```
微信消息到达
    ↓
AI 空闲？ → 否 → 加入 pendingMessages 队列
    ↓ 是
triggerAiInternal → sendUserMessage → AI 生成回复
    ↓
agent_settled → sendMessageWithRetry → 发送至微信
    ↓
onAiDone → 检查队列 → 触发下一条
```

**防重机制**：
- `processedRequests` Map 记录已处理的 requestId
- 每 50 次请求清理一次过期记录（1 小时前）
- 队列排空由 `safelyTriggerNext` 完成；底层发送由 `sendMessageWithRetry` 负责，
  最多重试 3 次并采用指数退避

## 项目结构

```
pi-wechat-extension/
├── index.ts                    # 插件入口（事件桥接 / 命令 / 工具）
├── wechat.ts                   # 引擎门面（单用户模式）
├── polling.ts                  # PollingLoop：长轮询 / 退避 / abort
├── queue.ts                    # TurnQueue + SerialTaskQueue
├── media-store.ts              # 媒体落盘 / 魔数识别 / 下载
├── typing.ts                   # TypingController
├── sender.ts                   # MessageSender
├── logger.ts                   # 统一日志 + 脱敏
├── time.ts                     # 共享时间戳
├── config.ts                   # 配置管理
│
├── api/                        # HTTP API（来自 Tencent/openclaw-weixin）
│   ├── api.ts                  # 底层请求封装
│   └── types.ts                # API 类型定义
│
├── auth/                       # 认证模块（来自 Tencent/openclaw-weixin）
│   ├── login-qr.ts             # 扫码登录
│   └── accounts.ts             # 账号配置
│
├── cdn/                        # CDN 模块（来自 Tencent/openclaw-weixin）
│   ├── cdn-url.ts
│   ├── cdn-upload.ts
│   ├── upload.ts               # 文件上传封装
│   ├── aes-ecb.ts              # AES-128-ECB 加密
│   └── pic-decrypt.ts          # CDN 内容解密
│
├── media/                      # 媒体处理（来自 Tencent/openclaw-weixin）
│   ├── media-download.ts       # 媒体下载与解密
│   ├── silk-transcode.ts       # SILK 转 WAV
│   └── mime.ts                 # MIME 类型检测
│
├── messaging/                  # 消息发送（来自 Tencent/openclaw-weixin）
│   ├── send.ts                 # 文字/图片/视频/文件发送
│   ├── send-media.ts           # 文件发送自动路由
│   ├── inbound.ts              # 入站消息处理
│   └── markdown-filter.ts      # Markdown 过滤
│
├── storage/
│   └── state.ts                # 持久化存储 + 单用户便捷函数
│
├── util/                       # 工具模块（来自 Tencent/openclaw-weixin）
│   ├── logger.ts               # 文件日志（JSON lines）
│   ├── redact.ts               # 敏感信息脱敏
│   └── random.ts               # 随机 ID 生成
│
├── tests/                      # 缺陷回归测试 + 分层夹具（bun test --isolate）
│   ├── unit/                   # config / storage / logger / dependencies
│   ├── engine/                 # wechat.ts / queue.ts / media-store.ts
│   └── bridge/                 # index.ts 事件桥接
│
├── .forgejo/workflows/ci.yml   # Forgejo Actions：test + typecheck
└── package.json
```

> **说明**：根目录下的 `index.ts`、`wechat.ts` 及其拆分出的协作模块（`polling.ts`、`queue.ts`、`media-store.ts`、`typing.ts`、`sender.ts`、`logger.ts`、`time.ts`）、`config.ts`、`storage/state.ts` 是本插件自写的核心代码；`api/`、`auth/`、`cdn/`、`media/`、`messaging/`、`util/` 适配自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。

