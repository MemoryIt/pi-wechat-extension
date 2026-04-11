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
- before_agent_start：解析 prompt，保存 requestId/userId，发送 typing=1 ✅
- turn_end：空操作（新版方案） ✅
- agent_end：防止重复，提取**最后一个**回复，sendMessageWithRetry() 发送 ✅
- agent_end：发送 typing=2 取消"正在输入" ✅
- sendMessageWithRetry()：3次重试（1s, 2s, 4s） ✅
- sendTypingStatus()：typing 状态发送 ✅
- cleanupProcessedRequests()：清理 1 小时前请求 ✅
- reset()：清理所有状态 ✅
- setConfig()：注入 wechatConfig ✅

**新版方案特点**：
- 只发 AI 的最终回复（解决 tool call 中间结果问题）
- 只取最后一个有内容的 assistant 消息
- typing=1 保持到 agent_end，然后发送 typing=2

---

### 3d: 稳定性 - 长时运行与异常处理
**验证标准**：长时间运行稳定，异常情况正确处理

**核心功能**：
- sendTyping()：typing 状态机
- session expired (-14) → 通知重新登录
- 轮询连续失败 → 指数退避重试（MAX_CONSECUTIVE_FAILURES）
- reset()：清理所有状态，session_shutdown 时调用
- cleanupProcessedRequests()：清理 1 小时前的请求记录
- saveSyncCursor() / loadSyncCursor() 持久化

---

## Phase 4: 与 pi-coding-agent 连接

### 4a: 生命周期事件
- session_start：加载凭证，启动轮询
- session_shutdown：停止轮询，清理状态

### 4b: AI 触发事件
- before_agent_start：识别微信消息，发送 typing=1
- turn_end：空操作（新版方案，不取消 typing）
- agent_end：发送最终回复 + typing=2

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

## Open Issues / TODO

## 已知局限性

- **Typing 状态**：发送 typing=1 后，微信端不显示"正在输入..."（待修复）

## Open Issues

- [ ] Typing 状态：发送 typing=1 后微信端不显示"正在输入..."，需要调查原因
- [ ] Slash Command：/echo, /toggle-debug, /help
- [ ] 稳定性测试：长时间运行
