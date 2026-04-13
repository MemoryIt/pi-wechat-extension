# Pi WeChat Extension 开发进度

## 已完成
- 设计文档 v1.4 完成
- Phase 1: 复制可复用模块（api/, cdn/, media/）
- 插件入口 index.ts：注册 /wechat 命令
- 登录流程 auth/login-qr.ts：扫码登录实现 ✅
- 登录测试：扫码成功，返回 botToken/accountId/userId/baseUrl ✅
- Phase 2: 存储登录凭证（storage/state.ts）✅
- **Phase 3a: 消息接收（wechat.ts 骨架 + 长轮询 + 消息格式化 + triggerAi）** ✅
- **Phase 3b: 消息队列（pendingMessages + isAiProcessing + triggerAi + safelyTriggerNext + setTimeout 时序修复）** ✅
- **Phase 3c: 回复发送（processedRequests + before_agent_start + agent_end + sendMessageWithRetry + reset）** ✅
- **新版方案：只发最后一条消息（解决 tool call 和多消息块问题）** ✅
- **Typing 状态修复（message_start/message_end + keepalive）** ✅
- **回复追加模型元信息（目录、分支、Token、百分比、成本、模型）** ✅

---

## Bug Fix: 消息队列时序问题 (2026-04-10)

**问题**：微信用户连发多条消息时，只能收到第一条回复，后续消息报错
```
Extension "<runtime>" error: Agent is already processing a prompt. 
Use steer() or followUp() to queue messages, or wait for completion.
```

**根因**：agent_end + setTimeout(10) 仍不够延迟，followUp 在 agent 未完全 settled 时调用

**修复方案**（基于 Grok 分析 pi issue #2110, #2860）：
- 用 safelyTriggerNext() 替代 processNextMessage()
- setTimeout(20ms) + 指数退避（20→30→45ms）
- 重试机制：最多 3 次
- 先 peek，成功后再 shift

**修改文件**：
- wechat.ts: 重写 onAiDone() 和新增 safelyTriggerNext()
- index.ts: agent_end 延迟从 10ms → 20ms

**验证**：微信连发 3 条消息，正常顺序回复，无报错 ✅

---

## Bug Fix: 只发最后一条消息 (2026-04-11)

**问题**：Tool call 场景下，微信端只能看到第一条回复，看不到最终回复

**根因**：
1. `event.messages?.find()` 只取第一个 assistant 消息
2. Tool call 后有多个 assistant 消息，需要取最后一个

**修复方案**：
- 改为从后往前遍历，找到最后一个有内容的 assistant 消息
- `turn_end` 改为空操作，不取消 typing
- `agent_end` 在发送回复后发送 `typing=2`

**修改文件**：
- index.ts: 修改 `handleAgentEnd()` 取最后一条消息

**验证**：微信发消息触发 tool call，只收到最终回复 ✅

---

## Bug Fix: Typing 状态修复 (2026-04-12)

**问题**：
1. 直接使用 context_token 作为 typing_ticket 不正确
2. 单次推理时间过长，typing 会提前消失

**根因**：
1. typing_ticket 和 context_token 是不同的字段，需要调用 getConfig API 获取
2. 微信端 typing 状态会在几秒后自动消失

**修复方案**：
1. 新增 getTypingTicket() 方法：先调用 getConfig 获取 typing_ticket（带 60 秒缓存）
2. 使用 typing_ticket 发送 typing 状态
3. 使用 message_start/message_end 事件精确控制 typing 时机
4. 在 message_start 到 message_end 之间，每 8 秒刷新一次 typing=1（keepalive）

**修改文件**：
- wechat.ts: 新增 getTypingTicket(), startTypingKeepalive(), stopTypingKeepalive()
- index.ts: message_start → startTypingKeepalive, message_end → stopTypingKeepalive

**验证**：微信发消息触发推理，typing 状态在整个推理期间持续显示 ✅

---

## Phase 3: 核心引擎（wechat.ts）

### 3a: 消息接收 - 微信 → pi 会话 ✅
**验证标准**：发微信消息 → pi 能看到并触发 AI 回复

**核心功能**：
- WechatEngine 基础框架（state: syncCursor, connectionState）
- startPolling()：长轮询获取消息
- handleMessage()：消息格式化
- formatWechatMessage()：生成 `__WECHAT_REQ_xxx__[WeChat; name] content`
- triggerAi()：pi.sendUserMessage(content, { deliverAs: "followUp" })
- stopPolling()：中止轮询
- 指数退避重试（consecutiveFailures）
- syncCursor 持久化

---

### 3b: 消息队列 - 同一用户消息顺序处理 ✅
**验证标准**：用户连发3条消息 → AI 按顺序逐条回复

**核心功能**：
- pendingMessages: Map<userId, Array<{ msg, requestId }>> ✅
- isAiProcessing: boolean ✅
- handleMessage()：AI 忙时加入队列，否则直接触发 ✅
- triggerAi()：设置 isAiProcessing，写入 wechat_meta 隐藏消息 ✅
- onAiDone()：AI 完成回调 ✅
- safelyTriggerNext()：AI 完成后安全处理下一条（带重试） ✅
- agent_end → setTimeout(20) → onAiDone() ✅

**时序问题修复**：agent_end 回调需用 setTimeout(20) 延迟 + safelyTriggerNext() 重试机制

---

### 3c: 回复发送 - pi 回复 → 微信 ✅
**验证标准**：发微信消息 → 收到微信回复

**核心功能**：
- currentUserId / currentRequestId 闭包变量
- processedRequests: Map<requestId, timestamp> 防重
- before_agent_start：解析 prompt，保存 requestId/userId ✅
- agent_end：防止重复，提取**最后一个**回复，sendMessageWithRetry() 发送 ✅
- sendMessageWithRetry()：3次重试（1s, 2s, 4s） ✅
- sendTypingStatus()：typing 状态发送 ✅
- cleanupProcessedRequests()：清理 1 小时前请求 ✅
- reset()：清理所有状态 ✅
- setConfig()：注入 wechatConfig ✅

**新版方案特点**：
- 只发 AI 的最终回复（解决 tool call 中间结果问题）
- 只取最后一个有内容的 assistant 消息

---

### 3d: 稳定性 - 长时运行与异常处理 ✅
**验证标准**：长时间运行稳定，异常情况正确处理

**核心功能**：
- typing_ticket 缓存（60秒）
- typing keepalive（每8秒刷新 typing=1）
- session expired (-14) → 通知重新登录
- 轮询连续失败 → 指数退避重试（MAX_CONSECUTIVE_FAILURES）
- reset()：清理所有状态，session_shutdown 时调用
- cleanupProcessedRequests()：清理 1 小时前的请求记录
- saveSyncCursor() / loadSyncCursor() 持久化

---

## Phase 4: 与 pi-coding-agent 连接

### 4a: 生命周期事件
- session_start：加载凭证，启动轮询 ✅
- session_shutdown：停止轮询，清理状态 ✅

### 4b: AI 触发事件
- before_agent_start：识别微信消息，保存 requestId/userId ✅
- message_start：启动 typing keepalive ✅
- message_end：停止 typing keepalive ✅
- agent_end：发送最终回复 ✅

### 4c: 回复拦截
- agent_end：提取**最后一个** assistant 回复，调用 sendMessage 发送回微信

### 4d: 上下文处理
- context：追加 system prompt，标识当前微信用户

---

## Phase 5: slash command
- /echo：回显消息
- /toggle-debug：切换调试模式
- /help：帮助信息

---

## Feature: 回复追加模型元信息 (2026-04-12)

**需求**：在每次微信回复后追加 pi 的目录和模型调用元信息

**格式**：
```
/path/to/dir (branch)
0.7%/205k $0.001 (provider) model-id
```

**实现方案**：
1. 通过 `ctx.ui.setFooter()` 注册回调获取 Git 分支（缓存到 `cachedGitBranch`）
2. `handleAgentEnd()` 中调用 `buildMetaInfo()` 构建元信息字符串
3. 将元信息追加到回复文本末尾（用空行分隔）

**获取的信息**：
| 信息 | 获取方式 |
|------|----------|
| 当前目录 | `ctx.cwd` |
| Git 分支 | `footerData.getGitBranch()` |
| Token 百分比 | `ctx.getContextUsage().percent` |
| Token 限制 | `ctx.getContextUsage().contextWindow` |
| 成本 | 从 session 累加 `usage.cost.total` |
| 模型提供商 | `ctx.model.provider` |
| 模型 ID | `ctx.model.id` |

**修改文件**：
- index.ts: 新增 `cachedGitBranch` 变量，`session_start` 中注册 footer 回调，`handleAgentEnd()` 中追加元信息

**注意**：无法获取网络流量（↓125 W）和模型选择模式（auto）信息

---

## Feature: 图片消息支持 (2026-04-13)

**需求**：接收微信图片消息，下载并保存，AI 可读取分析

**问题与解决方案**：

| 问题 | 解决方案 |
|------|----------|
| AES key 格式 | `image_item.aeskey` 是 32 字符 hex，需要 `Buffer.from(hex, 'hex')` 解码 |
| appendEntry 不加入 LLM 上下文 | 使用 `pi.sendMessage` + `deliverAs: "followUp"` |
| sendUserMessage 触发新回复 | 使用 `pi.sendMessage` 替代 |

**实现功能**：
1. **图片下载**：从 CDN 下载 + AES-128-ECB 解密
2. **AES key 解析**：支持 32 字符 hex 格式（image_item.aeskey）
3. **图片存储**：保存到 `~/.pi/agent/wechat/media/inbound/`
4. **纯图片拦截**：无文本的图片消息直接返回保存路径，不触发 AI
5. **路径共享**：使用 `pi.sendMessage` 把路径加入会话历史，AI 可看到

**消息格式**：
- 发送给微信：`图片已收到，成功保存到 /path/to/image.jpg`
- 加入历史：`[WeChat; userId] 图片已收到，成功保存到 /path/to/image.jpg`

**修改文件**：
- wechat.ts: 
  - 新增 `parseAesKey()` 方法（支持 hex/base64 格式）
  - 新增 `downloadImage()` 方法
  - 新增 `saveImageToStorage()` 函数
  - 修改 `handleMessage()` 拦截纯图片消息
  - 使用 `pi.sendMessage` 发送路径到历史

**验证**：
- 发送纯图片 → 收到保存路径消息 ✅
- 追问"描述图片" → AI 能看到路径并读取分析 ✅

---

## Open Issues

- [ ] Slash Command：/echo, /toggle-debug, /help
- [ ] 稳定性测试：长时间运行
