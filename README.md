# pi-wechat-extension

将微信接入 [pi coding agent](https://github.com/badlogic/pi-mono) 的扩展，实现「微信发消息 → pi 生成回复 → 微信收到」的双向交互。单用户模式：扫码登录一次，凭证持久化，下次自动连接。

> 架构、模块职责与关键机制见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 兼容性

| 项目 | 要求 |
|------|------|
| pi | `@earendil-works/pi-coding-agent` ≥ 0.84.3（本机验证 0.84.3） |
| 运行时 | Node.js ≥ 22（pi 自身要求 Node ≥ 22.19；插件无额外运行时依赖） |

> **兼容性说明**：本插件依赖 `@earendil-works/pi-coding-agent` 这一代 pi 的扩展 API
> （如 `agent_settled`、`pi.exec`、`ExtensionCommandContext`）。早期 `@mariozechner/pi-coding-agent`
> 版本（≤ 0.73 时代）不在支持范围内；在旧版本上自行尝试不保证可用。
>
> 开发/测试需要 **Bun**，详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 已实现功能

| 功能 | 说明 |
|------|------|
| 登录及持久化 | 扫码一次，登录信息保存到 `~/.pi/agent/wechat/`，下次启动自动连接 |
| 双向消息 | 微信 → pi 终端；AI 回复 → 微信 |
| 文件发送 | AI 通过 `send_wechat_file` 工具向微信发送本地文件（图片/视频/文档自动路由） |
| 媒体接收 | 微信发来的图片/语音/视频等在后台下载解密并落盘，路径写入会话历史 |
| Typing 指示 | AI 生成期间显示「正在输入」，每 8 秒刷新 |
| 运行信息追加 | 文本回复后追加：所在目录、Git 分支、上下文占用、Token 成本、模型信息 |

## 安装与卸载

推荐安装到某个本地项目（而非全局）：

```bash
cd /path/to/your-project

# 安装到项目级别（-l / --local）
pi install -l git:github.com/MemoryIt/pi-wechat-extension

# 验证
pi list          # Project packages: git:github.com/MemoryIt/pi-wechat-extension

# 卸载
pi remove -l git:github.com/MemoryIt/pi-wechat-extension
# 等价的别名
pi uninstall -l git:github.com/MemoryIt/pi-wechat-extension
```

## 快速开始

### 1. 登录微信

```
/wechat login
```

终端显示二维码，使用微信扫码完成登录。登录成功后凭证落盘并自动开始轮询。若二维码未显示，终端会打印可点击的链接。

### 2. 开始聊天

登录后自动连接。直接用微信给 bot 发消息，AI 回复会发回微信。

## 终端命令

| 命令 | 功能 |
|------|------|
| `/wechat login` | 扫码登录微信 |
| `/wechat logout` | 登出微信并清除凭证 |
| `/wechat status` | 查看登录用户与连接状态 |
| `/wechat start` | 手动启动轮询 |
| `/wechat stop` | 手动停止轮询 |

输入 `/wechat ` 后会有 `login/status/start/stop/logout` 子命令补全。

### `send_wechat_file` 工具

pi 可通过 `send_wechat_file` 向当前微信用户发送本地文件：

```jsonc
{
  "name": "send_wechat_file",
  "parameters": {
    "localPath": "string  // 必填：Pi 本地文件的完整绝对路径"
  }
}
```

- 仅接受 `localPath`，**没有** `fileName` 参数，也无法自定义微信显示名。
- 微信端显示名固定为本地文件名 `path.basename(localPath)`（D14）。
- 支持任意类型（pptx、pdf、jpg、png 等），底层自动路由图片/视频/文件上传。

**用法示例**：

```
请把 /Users/mou/code/pi-dev/sample.txt 发送给微信用户
```

## 配置

### 配置文件

`~/.pi/agent/wechat/config.json`：

```json
{
  "debug": false,
  "mediaStoragePath": "/custom/path/to/media"
}
```

### 环境变量

| 变量名 | 对应字段 | 说明 |
|--------|----------|------|
| `WECHAT_DEBUG` | `debug` | 调试模式（`true`/`false`） |
| `WECHAT_MEDIA_PATH` | `mediaStoragePath` | 媒体文件存储路径 |

### 配置项与优先级

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | boolean | `false` | 调试日志 |
| `mediaStoragePath` | string | `{agentDir}/wechat/media` | 媒体存储路径 |

**优先级**：环境变量 > `config.json` > 默认值。环境变量**按字段独立**覆盖：只设置某一项时，仅覆盖该字段，`config.json` 中的其它字段继续生效。

## 工作流程

```
微信发消息 → 长轮询接收 → 解析 turn → pi.sendUserMessage(content)
    ↓
AI 在终端生成回复
    ↓
message_start → Typing keepalive（每 8 秒刷新 typing=1）
    ↓
message_end → 停止 keepalive（仅 assistant 消息触发）
    ↓
agent_settled → 提取本轮最终 assistant 回复 + 元信息 → 发送至微信
```

- `agent_settled` 表示「一轮全部结束、不会再有自动重试/压缩/续跑」，最终回复在此**只发一次**且为最终版本。
- `agent_end` 仅用于 typing 收敛与终端标志兜底。
- 微信消息会以原始文本作为 user 消息注入（不再有 `[wechat]` / `WECHAT_REQ_xxx` 前缀）。

### 消息队列

AI 繁忙或终端正在处理消息时，新到的微信消息进入 FIFO 队列，待当前轮结束后依次处理，保证顺序。纯媒体消息会立即回执「媒体文件已收到，正在保存…」，下载/落盘在后台串行执行，不阻塞轮询主循环。

## 已知限制与排障

### 微信发送的 `/命令` 不会触发 pi 命令

通过 `pi.sendUserMessage()` 注入的消息（微信路径正是如此）**会绕过 slash command 路由器**，命令字符串会被当作普通用户消息交给 LLM，而不会执行内置命令（如 `/new`）或扩展命令。

- slash command 路由器只对**终端 interactive 输入**生效；`sendUserMessage` 的 `source="extension"` 不参与命令分发，也没有参数可强制路由。
- `ctx.newSession()`、`ctx.fork()` 等会话控制方法**仅存在于 `ExtensionCommandContext`**（`registerCommand` 的 handler 上下文），普通事件上下文不可用。
- 官方处理顺序：extension commands → `input` 事件 → skill/template 展开 → LLM。这是 **by design**（详见 `docs/ARCHITECTURE.md`）。

> 另外，自研通道层不再拦截以 `/` 开头的微信消息：这类消息会作为普通用户消息交给 LLM。
> 但由于上面的路由绕过，它们仍然不会触发 pi 的真实命令（by design）。

### D9 — 停止轮询不能真正取消在途请求

底层 `getUpdates` 不接受 `AbortSignal`。`/wechat stop` 通过 `Promise.race` 让轮询循环迅速退出，但在途 HTTP 请求仍会在后台直到自身超时（约 35s）才结束。

### D14 — 发送文件无法自定义显示名

底层 `sendWeixinMediaFile` 没有显示名参数，因此移除了 `send_wechat_file` 的 `fileName`；微信显示名以本地文件 basename 为准。

### 会话过期

登录失效时连接状态变为 `needs_relogin`，并通过 UI 提示「微信登录已失效，请执行 `/wechat login` 重新登录」。该状态不会被轮询结束时重置。

### 常见现象

| 现象 | 排查 |
|------|------|
| 启动后不自动连接 | 执行 `/wechat status`；未登录则 `/wechat login` |
| 回复失败 | 检查 `needs_relogin` 提示；重新登录 |
| 看不到调试日志 | 设置 `WECHAT_DEBUG=true`，或在 `config.json` 设 `"debug": true` |
| 媒体没有保存 | 检查 `mediaStoragePath`/`WECHAT_MEDIA_PATH` 是否可写 |
| 微信 `/命令` 不执行 pi 命令 | 见上文「微信发送的 `/命令` 不会触发 pi 命令」；消息会照常交给 LLM |

> 想了解框架结构、模块划分与开发/测试方式，请见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
