# Pi WeChat Extension 开发进度

## 已完成
- 设计文档 v1.4 完成
- Phase 1: 复制可复用模块（api/, cdn/, media/）
- 插件入口 index.ts：注册 /wechat 命令
- 登录流程 auth/login-qr.ts：扫码登录实现 ✅
- 登录测试：扫码成功，返回 botToken/accountId/userId/baseUrl ✅
- Phase 2: 存储登录凭证（storage/state.ts）✅
- **Phase 3a: 消息接收（wechat.ts 骨架 + 长轮询 + 消息格式化 + triggerAi）** ✅
- **Phase 3b: 消息队列（pendingMessages + isAiProcessing + triggerAi + processNextMessage + setTimeout 时序修复）** ✅
- **Phase 3c: 回复发送（processedRequests + before_agent_start + turn_end + agent_end + sendMessageWithRetry + reset）** ✅

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

**不含**：typing、agent_end 拦截

---

### 3b: 消息队列 - 同一用户消息顺序处理 ✅
**验证标准**：用户连发3条消息 → AI 按顺序逐条回复

**核心功能**：
- pendingMessages: Map<userId, Array<{ msg, requestId }>> ✅
- isAiProcessing: boolean ✅
- handleMessage()：AI 忙时加入队列，否则直接触发 ✅
- triggerAi()：设置 isAiProcessing，写入 wechat_meta 隐藏消息 ✅
- onAiDone()：AI 完成回调 ✅
- processNextMessage()：AI 完成后取下一条处理 ✅
- agent_end → setTimeout(10) → onAiDone() ✅

**⚠️ v0.65.2 时序问题**：agent_end 回调直接调用 sendUserMessage 有时序问题，需用 setTimeout(10) 延迟

**不含**：typing

---

### 3c: 回复发送 - pi 回复 → 微信 ✅
**验证标准**：发微信消息 → 收到微信回复

**核心功能**：
- currentUserId / currentRequestId 闭包变量
- processedRequests: Map<requestId, timestamp> 防重
- before_agent_start：解析 prompt，保存 requestId/userId，发送 typing=1 ✅
- turn_end：发送 typing=2 ✅
- agent_end：防止重复，提取回复，sendMessageWithRetry() 发送 ✅
- sendMessageWithRetry()：3次重试（1s, 2s, 4s） ✅
- sendTypingStatus()：typing 状态发送 ✅
- cleanupProcessedRequests()：清理 1 小时前请求 ✅
- reset()：清理所有状态 ✅
- setConfig()：注入 wechatConfig ✅

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
- session_start：加载凭证，启动长轮询
- session_shutdown：停止轮询，清理状态

### 4b: AI 触发事件
- before_agent_start：识别微信消息，发送 typing=1
- turn_end：发送 typing=2 取消

### 4c: 回复拦截
- agent_end：提取 AI 回复，调用 sendMessage 发送回微信

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

- **Tool Call 场景**：当 AI 调用工具（如执行命令）时，微信端只能看到工具调用前的回复，后续的工具执行结果和最终回复不会发送
- **多轮对话**：如果 AI 输出多个消息块，只有第一个会发送
- **Typing 状态**：before_agent_start/turn_end 发送 typing=1/2 未实际验证

## Open Issues

- [ ] Typing 状态：验证并修复 typing 状态发送
- [ ] Tool Call 场景：支持多消息块发送（turn_end 事件中发送每个回复）
