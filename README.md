# pi-wechat-extension

微信插件，将微信接入 pi coding agent，实现"微信聊天 → AI 回复"的双向交互。

## 兼容性

| 项目 | 版本 |
|------|------|
| pi | 0.65.2 |

## 已实现功能

### 命令

| 命令 | 功能 |
|------|------|
| `/wechat login` | 扫码登录微信 |
| `/wechat logout` | 登出微信 |
| `/wechat status` | 查看连接状态 |
| `/wechat start` | 手动启动轮询 |
| `/wechat stop` | 手动停止轮询 |

### 核心功能

- **扫码登录**：扫码一次，登录信息持久化保存，下次打开无需扫码
- **消息接收**：微信发消息 → pi 终端显示
- **消息回复**：AI 在终端回复 → 微信端收到回复（**双向交互**）
- **长轮询**：实时接收微信消息
- **连续消息队列**：用户连发多条消息，AI 按顺序逐条回复
- **Typing 指示器**：AI 推理时显示 "正在输入..."
- **媒体文件支持**：接收并保存语音/图片/视频/文件，AI 可读取分析
- **模型元信息**：回复后追加当前目录、Git 分支、Token 使用、模型等信息

## 配置

### 配置文件

创建 `~/.pi/agent/wechat/config.json`：

```json
{
  "prefix": "[wechat]",
  "debug": false,
  "mediaStoragePath": "/custom/path/to/media"
}
```

### 环境变量

| 变量名 | 说明 |
|--------|------|
| `WECHAT_PREFIX` | 消息前缀 |
| `WECHAT_DEBUG` | 调试模式 (`true`/`false`) |
| `WECHAT_MEDIA_PATH` | 媒体文件存储路径 |

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `prefix` | string | `[wechat]` | 消息前缀 |
| `debug` | boolean | `false` | 调试模式 |
| `mediaStoragePath` | string | `{agentDir}/wechat/media` | 媒体文件存储路径 |

**配置优先级**: 环境变量 > config.json > 默认值

## 工作流程

```
微信发消息 → pi 收到消息 → pi 终端显示 → AI 在终端回复 → 微信端收到回复
```

## 快速开始

### 1. 安装插件

将项目链接添加到 pi 扩展配置。

### 2. 安装依赖

```bash
npm install
# 或
pnpm install
```

### 3. 登录微信

```
/wechat login
```
扫描二维码完成登录。

### 4. 开始聊天

登录后自动连接微信。直接通过微信给 bot 发消息，在 **pi 终端**中查看 AI 回复。

## 消息格式

微信消息在 pi 会话中显示为：

```
[wechat] 你好，我想问问项目进度
[wechat] 媒体文件已收到，成功保存到 /path/to/image.jpg
[wechat] 媒体文件已收到，成功保存到 /path/to/audio.silk
[wechat] 媒体文件已收到，成功保存到 /path/to/document.pdf
[wechat] 媒体文件已收到，成功保存到 /path/to/video.mp4
```

**媒体文件存储路径**：可通过 `config.json` 或环境变量 `WECHAT_MEDIA_PATH` 配置，默认存储在 `~/.pi/agent/wechat/media/` 目录下。

## 技术细节

### 单用户模式

插件仅支持单用户模式，简化了多用户场景下的复杂逻辑。

### 持久化存储

```
~/.pi/agent/wechat/
├── accounts.json           # 账号索引
├── config.json             # 插件配置
└── accounts/
    └── {accountId}/
        ├── token.json           # 登录凭证
        ├── context-tokens.json   # 用户上下文 tokens
        └── sync.json            # 轮询 sync cursor
```

## 项目结构

```
pi-wechat-extension/
├── index.ts              # 插件入口
├── wechat.ts             # 核心引擎（单用户版本）
├── config.ts             # 配置管理
├── api/                  # HTTP API
│   ├── api.ts
│   ├── types.ts
│   └── session-guard.ts
├── auth/
│   └── login-qr.ts       # 扫码登录
├── media/
│   └── media-download.ts
├── storage/
│   └── state.ts          # 持久化存储
├── util/
│   ├── logger.ts
│   └── redact.ts
├── types.ts
├── config.test.ts        # 配置测试
├── wechat.test.ts        # 引擎测试
└── package.json
```

## 开发

### 构建

```bash
pnpm install
pnpm build
```

### 测试

项目使用 [Vitest](https://vitest.dev/) 作为测试框架。

#### 运行测试

```bash
# 运行所有测试（一次性）
pnpm test

# 监听模式（文件变化时自动重新运行）
pnpm test --watch

# 运行特定测试文件
pnpm test -- wechat.test.ts
pnpm test -- config.test.ts
pnpm test -- storage/storage.test.ts

# 显示测试覆盖率
pnpm test -- --coverage
```

#### 测试文件

| 文件 | 说明 |
|------|------|
| `config.test.ts` | 配置管理测试（前缀、默认值、覆盖、环境变量） |
| `wechat.test.ts` | 核心引擎测试（requestId、消息格式化、队列、Typing、发送、防重） |
| `storage/storage.test.ts` | 存储模块测试（持久化函数存在性检查） |

#### 测试覆盖模块

| 模块 | 测试内容 |
|------|----------|
| **requestId 生成** | 格式验证、唯一性、时间戳精度 |
| **消息格式化** | 文本消息、图片消息、混合内容、空内容 |
| **单用户初始化** | 凭证加载、contextToken 缺失警告 |
| **消息队列** | 入队、出队、并发处理 |
| **Typing Keepalive** | 启动、停止、ticket 缓存、错误恢复 |
| **消息发送** | 单用户回复、重试机制、防重检查 |
| **状态重置** | 全局状态清理 |
| **消息处理流程** | slash command 检测、contextToken 更新 |

#### 测试用例统计

```
config.test.ts         : 10 个测试用例
wechat.test.ts         : 27 个测试用例
storage/storage.test.ts :  9 个测试用例
────────────────────────────────────────
总计                    : 46 个测试用例
```

### 类型检查

```bash
pnpm typecheck
```
