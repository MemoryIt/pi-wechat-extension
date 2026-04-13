# Pi WeChat Extension - 技术规格文档

> **文档版本**: v1.6
> **最后更新**: 2026-04-13
> **参考**: openclaw-weixin 源码 + pi coding-agent 机制（Grok 分析）

---

## 1. 概述

**项目名称**: pi-wechat-extension
**项目类型**: Pi Coding Agent Extension (pi package)
**核心功能**: 将微信接入 pi，实现"微信聊天 → AI 回复"的双向交互
**目标用户**: 希望在微信上与 AI 对话的用户

### 设计决策

| 决策项 | 选择 |
|--------|------|
| 消息交互模式 | 单主会话 + 消息前缀隔离 |
| 账号支持 | 单账号（扫码登录） |
| AI 触发方式 | `pi.sendUserMessage(content, { deliverAs: "followUp" })` |
| WeChat 触发识别 | 通过 prompt 正则（`__WECHAT_REQ_ + [WeChat; name]`）识别 |
| 临时状态传递 | `wechat_meta` 隐藏消息 + 闭包变量 |
| Typing 控制 | `message_start` → keepalive, `message_end` → 停止 |
| 技术路线 | 复用 openclaw-weixin API/媒体模块 |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Pi Coding Agent                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   pi-wechat-extension                      │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │  │
│  │  │   login     │  │  polling    │  │  message queue   │  │  │
│  │  │  (QR code)  │  │  (longpoll) │  │  (per user)     │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │  │
│  │         │                │                   │            │  │
│  │         └────────────────┼───────────────────┘            │  │
│  │                          │                                │  │
│  │  ┌──────────────────────▼────────────────────────────┐   │  │
│  │  │              wechat.ts (核心引擎)                     │   │  │
│  │  │  • userContexts: Map<userId, UserContext>         │   │  │
│  │  │  • pendingMessages: Map<userId, WeixinMessage[]>   │   │  │
│  │  │  • currentUserId: string | null                   │   │  │
│  │  │  • currentRequestId: string | null                │   │  │
│  │  │  • processedRequests: Map<id,timestamp> (防重复+清理) │   │  │
│  │  │  • typingTicketCache: Map<userId, ticket> (60s TTL) │   │  │
│  │  │  • typingKeepaliveTimers: Map<userId, Timer>      │   │  │
│  │  └───────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                             │                                   │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   ilinkai.weixin.qq.com API   │
              │   • getUpdates (long-poll)    │
              │   • sendMessage               │
              │   • sendTyping                │
              │   • getConfig (typing_ticket) │
              │   • get_bot_qrcode           │
              └───────────────────────────────┘
```

### 2.2 模块划分

```
pi-wechat-extension/
├── index.ts              # Extension 入口
├── wechat.ts             # 核心引擎
├── api/                  # HTTP API（直接复用）
│   ├── api.ts
│   ├── types.ts
│   └── session-guard.ts
├── auth/
│   └── login-qr.ts       # 扫码登录
├── media/
│   └── media-download.ts
├── storage/
│   └── state.ts          # token、context-token、sync-buf
├── types.ts
└── package.json
```

---

## 3. 核心设计

### 3.1 闭包状态（WechatEngine 类）

```typescript
class WechatEngine {
  // 用户上下文映射（持久化到磁盘）
  private userContexts = new Map<string, UserContext>();
  
  // 消息队列：同一用户的多条消息排队（存储 msg + requestId）
  private pendingMessages = new Map<string, Array<{ msg: WeixinMessage; requestId: string }>>();
  
  // 当前处理的 userId（闭包变量）
  private currentUserId: string | null = null;
  
  // 当前请求 ID（闭包变量，用于 agent_end 匹配）
  private currentRequestId: string | null = null;
  
  // AI 是否正在处理（防止并发）
  private isAiProcessing = false;
  
  // 已处理的请求 ID + timestamp（用于防重 + 定期清理）
  private processedRequests = new Map<string, number>();
  
  // 长轮询 abort signal
  private abortController = new AbortController();
  
  // 轮询连续失败计数
  private consecutiveFailures = 0;
  
  // processedRequests 清理计数器
  private cleanupCounter = 0;
  
  // === Typing 相关状态 ===
  // typing_ticket 缓存（60秒）
  private typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();
  
  // typing keepalive 定时器
  private typingKeepaliveTimers = new Map<string, NodeJS.Timeout>();
  
  // typing keepalive 间隔（8秒）
  private readonly TYPING_KEEPALIVE_INTERVAL_MS = 8000;
  
  // typing_ticket 缓存有效期（60秒）
  private readonly TYPING_TICKET_CACHE_TTL_MS = 60000;
  
  // 停止长轮询
  stopPolling(): void {
    this.abortController.abort();
  }
  
  // 清理旧的 processedRequests（计数器在清理完成后重置）
  cleanupProcessedRequests(): void {
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, timestamp] of this.processedRequests) {
      if (timestamp < oneHourAgo) {
        this.processedRequests.delete(id);
      }
    }
    this.cleanupCounter = 0; // 清理完成后重置计数器
  }
  
  // 清理所有状态（session_shutdown 时调用）
  reset(): void {
    // 停止所有 typing keepalive
    for (const [userId] of this.typingKeepaliveTimers) {
      this.stopTypingKeepalive(userId);
    }
    this.typingKeepaliveTimers.clear();
    this.typingTicketCache.clear();
    
    this.pendingMessages.clear();
    this.processedRequests.clear();
    this.currentUserId = null;
    this.currentRequestId = null;
    this.isAiProcessing = false;
    this.cleanupCounter = 0;
    this.abortController = new AbortController(); // 重建（新 abort signal）
  }
}
```

### 3.2 消息格式

**注入主会话的格式**：
```
[WeChat; 张三] 你好，我想问问项目进度
__WECHAT_REQ_abc123__[WeChat; 张三] [图片: /path/to/img.jpg]
```

**格式说明**：
- `[WeChat; {displayName}]` - 用户标签
- `__WECHAT_REQ_{requestId}__` - 隐藏请求 ID（用于精确追踪）

**请求 ID 生成**：
```typescript
function generateRequestId(): string {
  // 使用时间戳 + 随机数，减少冲突概率，限制长度 16 字符
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 16);
}
```

### 3.3 消息处理流程

```
收到微信消息 (WeixinMessage)
    ↓
1. slash command 检查（/echo, /toggle-debug, /help）
    ↓ 是 → 直接回复，跳过 AI
2. 生成 requestId
    ↓
3. 保存/更新 userContext（context_token）
    ↓
4. **纯图片检测**：hasImage=true && hasText=false？
    ↓ 是 → 下载图片 → 发送保存路径到微信 → pi.sendMessage 加入历史 → 跳过 AI
5. 下载媒体（文本+图片混合格式）→ 持久化路径
    ↓
6. 格式化消息：`__WECHAT_REQ_{id}__[WeChat; user] content`
    ↓
7. 写入 wechat_meta 隐藏消息：`pi.appendEntry("wechat_meta", { requestId, userId, timestamp })`
    ↓
8. pi.sendUserMessage(formatted, { deliverAs: "followUp" })
    ↓
9. ⚠️ agent_end 时序问题修复（见 issue #2110, #2860）：
   - agent_end 回调使用 setTimeout(20) 延迟
   - onAiDone() 调用 safelyTriggerNext()
   - safelyTriggerNext() 使用 setTimeout(20) + 指数退避重试（20→30→45ms）
   - 最多重试 3 次
    ↓
10. AI 开始生成 → message_start → 启动 typing keepalive（每 8 秒刷新）
    ↓
11. AI 生成完成 → message_end → 停止 typing keepalive
    ↓
12. agent_end 拦截 → 从 wechat_meta 查找 requestId → 提取最后一条回复 → 发送
    ↓
13. safelyTriggerNext(userId) 安全地处理队列中的下一条
```

---

## 4. 事件处理（核心）

### 4.1 session_start：初始化

```typescript
pi.on("session_start", async (_event, ctx) => {
  // 加载存储的 context tokens
  await engine.loadPersistedContextTokens();
  
  // 启动长轮询
  engine.startPolling();
});
```

### 4.2 session_shutdown：清理

```typescript
pi.on("session_shutdown", async () => {
  engine.stopPolling();
  engine.reset(); // 清理所有状态
});
```

### 4.3 before_agent_start：识别 WeChat 触发

**关键**：通过 prompt 正则匹配判断是否是 WeChat 消息，保存 requestId/userId 供后续使用

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 通过 prompt 正则判断是否是 WeChat 消息
  const requestIdMatch = event.prompt?.match(/__WECHAT_REQ_([a-z0-9]+)__/);
  const userMatch = event.prompt?.match(/\[WeChat; ([^\]]+)\]/);
  
  // 不是 WeChat 消息，跳过
  if (!userMatch) return;
  
  const displayName = userMatch[1];
  const requestId = requestIdMatch?.[1] ?? null;
  
  const userCtx = findUserContextByDisplayName(displayName);
  if (!userCtx) return;
  
  // 保存当前用户和 requestId（闭包变量，供 message_start/message_end/agent_end 使用）
  engine.setCurrentRequest(requestId, userCtx.userId);
});
```

### 4.4 message_start：启动 typing keepalive

**关键**：AI 开始生成消息时启动 keepalive，每 8 秒刷新一次 typing 状态

```typescript
pi.on("message_start", async (event, ctx) => {
  const userId = engine.getCurrentUserId();
  if (!userId) return;
  
  const userCtx = engine.getUserContexts().get(userId);
  if (!userCtx) return;
  
  // 启动 typing keepalive（每 8 秒发送 typing=1）
  await engine.startTypingKeepalive(userId, userCtx.contextToken);
});
```

### 4.5 message_end：停止 typing keepalive

**关键**：AI 消息生成结束时停止 keepalive

```typescript
pi.on("message_end", async (event, ctx) => {
  const userId = engine.getCurrentUserId();
  if (!userId) return;
  
  const userCtx = engine.getUserContexts().get(userId);
  if (!userCtx) return;
  
  // 停止 typing keepalive
  await engine.stopTypingKeepalive(userId);
});
```

### 4.6 agent_end：拦截回复并发送回微信

**关键**：
1. 从 session entries 中查找 `wechat_meta` 获取 requestId（不依赖 event.source）
2. 用 `processedRequests` Map + 定期清理防止重复处理
3. 提取**最后一个**有内容的 assistant 消息（解决 tool call 问题）

```typescript
pi.on("agent_end", async (event, ctx) => {
  setTimeout(async () => {
    // 获取 requestId 和 userId：优先用闭包（最快），fallback 查 entries
    const requestId = engine.getCurrentRequestId();
    let userId = engine.getCurrentUserId();
    
    if (!userId && requestId) {
      const entries = ctx.sessionManager.getBranch();
      const wechatMeta = entries
        .filter(e => e.type === "custom" && e.customType === "wechat_meta")
        .reverse()
        .find(e => e.data?.requestId === requestId);
      userId = wechatMeta?.data?.userId ?? null;
    }
    
    if (!requestId || !userId) return;
    
    // 防止重复处理
    if (engine.processedRequests.has(requestId)) return;
    engine.processedRequests.set(requestId, Date.now());
    
    const userCtx = engine.getUserContexts().get(userId);
    if (!userCtx) return;
    
    // 提取 AI 回复：从后往前遍历，找到最后一个有内容的 assistant 消息
    const assistantMessages = event.messages?.filter?.(m => m.role === "assistant") ?? [];
    let assistantMsg = null;
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const msg = assistantMessages[i];
      const text = extractText(msg);
      if (text) {
        assistantMsg = msg;
        break;
      }
    }
    
    if (!assistantMsg) return;
    
    const replyText = extractText(assistantMsg);
    if (!replyText) return;
    
    // 发送回微信（带重试）
    try {
      await engine.sendMessageWithRetry(userId, userCtx.contextToken, replyText);
    } catch (err) {
      ctx.ui.notify(`微信回复失败: ${err.message}`, "error");
    }
    
    // 处理队列中的下一条消息
    engine.onAiDone();
  }, 20);
});
```

### 4.7 context：过滤消息（可选）

```typescript
pi.on("context", async (event, ctx) => {
  // 通过 prompt 判断是否是 WeChat 消息
  const userMatch = event.prompt?.match(/\[WeChat; ([^\]]+)\]/);
  if (!userMatch) return;
  
  // 保持 messages 不变（让 LLM 看到完整上下文）
  return { messages: event.messages };
});
```

---

## 5. Typing 机制

### 5.1 核心逻辑

```
message_start → startTypingKeepalive()
                    ↓
              发送 typing=1
                    ↓
              启动定时器（每 8 秒）
                    ↓
              定时器触发 → 发送 typing=1（刷新）
                    ↓
message_end → stopTypingKeepalive()
                    ↓
              清除定时器
                    ↓
              发送 typing=2（取消）
```

### 5.2 typing_ticket 获取

**关键**：必须先调用 getConfig API 获取 typing_ticket，不能直接使用 context_token

```typescript
async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
  // 检查缓存（60秒）
  const cached = this.typingTicketCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.ticket;
  }
  
  // 调用 getConfig 获取新的 typing_ticket
  const configResp = await getConfig({
    ilinkUserId: userId,
    contextToken: contextToken,
  });
  
  if (configResp.ret === 0 && configResp.typing_ticket) {
    // 缓存新 ticket
    this.typingTicketCache.set(userId, {
      ticket: configResp.typing_ticket,
      expiresAt: Date.now() + this.TYPING_TICKET_CACHE_TTL_MS,
    });
    return configResp.typing_ticket;
  }
  
  return null;
}
```

### 5.3 keepalive 实现

```typescript
async startTypingKeepalive(userId: string, contextToken: string): Promise<void> {
  // 先停止已有的 keepalive
  await this.stopTypingKeepalive(userId);
  
  // 立即发送一次 typing=1
  await this.sendTypingStatus(userId, contextToken, 1);
  
  // 设置定时器，每 8 秒刷新一次
  const timer = setInterval(async () => {
    await this.sendTypingStatus(userId, contextToken, 1);
  }, this.TYPING_KEEPALIVE_INTERVAL_MS);
  
  this.typingKeepaliveTimers.set(userId, timer);
}

async stopTypingKeepalive(userId: string): Promise<void> {
  const timer = this.typingKeepaliveTimers.get(userId);
  if (timer) {
    clearInterval(timer);
    this.typingKeepaliveTimers.delete(userId);
  }
}
```

---

## 6. 长轮询循环

### 6.1 轮询实现

```typescript
async startPolling(): Promise<void> {
  const abortSignal = this.abortController.signal;
  
  while (!abortSignal.aborted) {
    try {
      const updates = await wechatApi.getUpdates({
        get_updates_buf: this.state.syncCursor,
        longpolling_timeout_ms: 35_000,
      });
      
      for (const msg of updates.msgs) {
        await this.handleMessage(msg);
      }
      
      this.state.syncCursor = updates.get_updates_buf;
      await this.storage.saveSyncCursor(this.state.syncCursor);
      this.consecutiveFailures = 0; // 成功，重置计数
      
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.state.connectionState = "needs_relogin";
        return;
      }
      
      await this.handlePollError(error);
    }
  }
}

async handlePollError(error: Error): Promise<void> {
  this.consecutiveFailures++;
  
  if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    await sleep(BACKOFF_DELAY_MS);
    this.consecutiveFailures = 0;
  } else {
    await sleep(2000 * this.consecutiveFailures);
  }
}
```

### 6.2 关键常量

```typescript
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
const TYPING_KEEPALIVE_INTERVAL_MS = 8_000;
const TYPING_TICKET_CACHE_TTL_MS = 60_000;
```

---

## 7. 消息队列处理

### 7.1 handleMessage

```typescript
async handleMessage(msg: WeixinMessage): Promise<void> {
  const userId = msg.from_user_id;
  const requestId = generateRequestId();
  
  // 更新 context token
  if (msg.context_token) {
    const existing = this.userContexts.get(userId);
    this.userContexts.set(userId, {
      userId,
      contextToken: msg.context_token,
      displayName: existing?.displayName ?? userId,
    });
    // 异步持久化
    this.persistContextToken(userId, existing?.displayName ?? userId, msg.context_token);
  }
  
  // 如果当前正在处理该用户，加入队列
  if (this.isAiProcessing && this.currentUserId === userId) {
    const queue = this.pendingMessages.get(userId) ?? [];
    queue.push({ msg, requestId });
    this.pendingMessages.set(userId, queue);
    return;
  }
  
  // 触发 AI 处理
  await this.triggerAiForUser(userId, msg, requestId);
}
```

### 7.2 triggerAiForUser

```typescript
async triggerAiForUser(userId: string, msg: WeixinMessage, requestId: string): Promise<void> {
  this.currentUserId = userId;
  this.currentRequestId = requestId;
  this.isAiProcessing = true;
  
  // 格式化消息
  const formatted = this.formatWechatMessage(msg, requestId);
  
  // 写入 wechat_meta 隐藏消息
  pi.appendEntry("wechat_meta", { requestId, userId, timestamp: Date.now() });
  
  // 使用 followUp，队列处理由 safelyTriggerNext 负责
  await pi.sendUserMessage(formatted, {
    deliverAs: "followUp",
  });
}
```

### 7.3 safelyTriggerNext

```typescript
private safelyTriggerNext(userId: string, retryCount = 0): void {
  const MAX_RETRY = 3;
  const BASE_DELAY = 20;

  setTimeout(() => {
    const queue = this.pendingMessages.get(userId);
    if (!queue?.length) {
      this.isAiProcessing = false;
      return;
    }

    try {
      const { msg, requestId } = queue[0]; // peek
      this.triggerAiForUser(userId, msg, requestId);
      queue.shift(); // 成功后再移除
    } catch (err: any) {
      if (err.message?.includes("already processing") && retryCount < MAX_RETRY) {
        this.safelyTriggerNext(userId, retryCount + 1);
      } else {
        queue.shift();
        this.isAiProcessing = false;
        this.safelyTriggerNext(userId);
      }
    }
  }, BASE_DELAY * Math.pow(1.5, retryCount)); // 20 → 30 → 45ms
}
```

---

## 8. sendMessage 重试机制

```typescript
async sendMessageWithRetry(
  toUserId: string,
  contextToken: string,
  text: string,
  maxRetries: number = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const msg: WeixinMessage = {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      };
      
      await sendMessage({ body: { msg } });
      return;
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
      }
    }
  }
  
  throw lastError!;
}
```

---

## 9. 登录流程

### 9.1 状态机

```
get_bot_qrcode → 显示二维码
    ↓
get_qrcode_status 轮询（35s timeout）
    ├── wait → "等待扫码"
    ├── scaned → "已扫码，等待确认"
    ├── confirmed → 保存 token，关闭二维码
    ├── expired → 刷新（最多3次）
    └── scaned_but_redirect → 切换 IDC baseUrl
```

---

## 10. 持久化存储

### 10.1 目录结构

```
~/.pi/agent/wechat/
├── accounts.json
└── accounts/
    └── {accountId}/
        ├── account.json
        ├── token.json          # chmod 600
        ├── context-tokens.json
        └── sync.json
```

### 10.2 context-tokens.json

```json
{
  "wxid_user_a": { "displayName": "张三", "contextToken": "ctx_xxx", "lastMessageAt": 1712900000000 },
  "wxid_user_b": { "displayName": "李四", "contextToken": "ctx_yyy", "lastMessageAt": 1712901000000 }
}
```

---

## 11. API 与工具

### 11.1 注册的命令

| 命令 | 功能 |
|------|------|
| `/wechat login` | 扫码登录微信 |
| `/wechat logout` | 登出微信 |
| `/wechat status` | 查看连接状态 |
| `/wechat start` | 手动启动轮询 |
| `/wechat stop` | 手动停止轮询 |

---

## 12. 依赖

### 生产依赖
```json
{
  "qrcode-terminal": "0.12.0",
  "zod": "4.3.6"
}
```

### 开发依赖
```json
{
  "@mariozechner/pi-coding-agent": "latest",
  "typescript": "^5.8.0",
  "vitest": "^4.1.3"
}
```

---

## 13. 图片消息处理

### 13.1 处理流程

```
收到纯图片消息（无文本）
    ↓
检测 hasImage=true && hasText=false
    ↓
下载图片（CDN + AES 解密）
    ↓
保存到 ~/.pi/agent/wechat/media/inbound/
    ↓
发送回复给微信：图片已收到，成功保存到 {路径}
    ↓
使用 pi.sendMessage 加入会话历史（不触发 AI）
    ↓
用户追问时，AI 可从历史中看到路径并读取分析
```

### 13.2 AES Key 解析

**重要**：微信图片的 `aeskey` 格式与 `media.aes_key` 不同！

| 字段 | 格式 | 解析方式 |
|------|------|----------|
| `image_item.aeskey` | 32 字符 hex 字符串 | `Buffer.from(hex, 'hex')` |
| `image_item.media.aes_key` | base64 编码 | `Buffer.from(base64, 'base64')` |
| `CDNMedia.aes_key` | base64 或 base64(hex) | 智能解析 |

**parseAesKey 实现**：

```typescript
private parseAesKey(aesKeyInput: string): Buffer | null {
  const trimmed = aesKeyInput.trim();

  // Case 1: 直接 32 字符 hex（image_item.aeskey 最常见）
  if (trimmed.length === 32 && /^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Case 2: Base64 编码
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) return decoded;
    // 如果是 24 字节，可能是 hex 再 base64
    if (decoded.length === 24) {
      const hexStr = decoded.toString("utf8").trim();
      if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
        return Buffer.from(hexStr, "hex");
      }
    }
  } catch { /* ignore */ }

  return null;
}
```

### 13.3 图片下载

```typescript
async downloadImage(img: ImageItem, baseUrl: string, token: string): Promise<string | null> {
  // 优先使用缩略图，其次原图
  const target = img.thumb_media || img.media;
  const fullUrl = target?.full_url;

  // 优先使用 image_item.aeskey（hex），其次 media.aes_key（base64）
  const aesKeyRaw = img.aeskey || img.media?.aes_key;

  if (!fullUrl || !aesKeyRaw) return null;

  const aesKey = this.parseAesKey(aesKeyRaw);
  if (!aesKey) return null;

  // 下载加密数据
  const res = await fetch(fullUrl);
  const encrypted = Buffer.from(await res.arrayBuffer());

  // AES-128-ECB 解密
  const decrypted = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  const final = Buffer.concat([decrypted.update(encrypted), decrypted.final()]);

  // 保存到本地
  return saveImageToStorage(final, ".jpg");
}
```

### 13.4 纯图片消息拦截

```typescript
async handleMessage(msg: WeixinMessage, opts): Promise<void> {
  const hasText = msg.item_list?.some(item => item.type === 1 && item.text_item?.text?.trim());
  const hasImage = msg.item_list?.some(item => item.type === 2);

  if (hasImage && !hasText) {
    // 下载图片
    const imagePaths = [];
    for (const item of msg.item_list ?? []) {
      if (item.type === 2) {
        const path = await this.downloadImage(item.image_item, opts.baseUrl, opts.token);
        if (path) imagePaths.push(path);
      }
    }

    // 发送回复给微信
    const replyText = `图片已收到，成功保存到 ${imagePaths[0]}`;
    await this.sendReplyToUser(userId, replyText, contextToken);

    // 使用 pi.sendMessage 加入会话历史（不触发 AI）
    (pi.sendMessage as any)(
      { customType: "wechat-image-path", content: `[WeChat; ${userId}] ${replyText}` },
      { triggerTurn: false, deliverAs: "followUp" }
    );

    return; // 不触发 AI
  }

  // 正常处理文本消息...
}
```

### 13.5 存储路径

```
~/.pi/agent/wechat/media/inbound/
├── 20260413_abc12345.jpg
└── 20260413_def67890.jpg
```

**文件名格式**：`{timestamp}_{random8hex}.jpg`

### 13.6 与 pi.sendMessage 的区别

| API | 用途 | 是否加入 LLM 上下文 | 是否触发 AI 回复 |
|-----|------|-------------------|-----------------|
| `pi.sendUserMessage()` | 发送用户消息触发 AI | ✅ | ✅ |
| `pi.sendMessage()` | 发送自定义消息 | ✅ | ❌ |
| `pi.appendEntry()` | 发送自定义状态（custom entry） | ❌ | ❌ |

---

## 附录 A: 辅助函数

```typescript
/**
 * 根据 displayName 查找 UserContext
 * 优先精确匹配 displayName，fallback 到 userId 前缀匹配
 */
function findUserContextByDisplayName(displayName: string): UserContext | null {
  // 精确匹配
  for (const ctx of engine.userContexts.values()) {
    if (ctx.displayName === displayName) return ctx;
  }
  // fallback：userId 前缀匹配（防止 displayName 变化）
  for (const ctx of engine.userContexts.values()) {
    if (ctx.userId.startsWith(displayName) || displayName.startsWith(ctx.userId)) {
      return ctx;
    }
  }
  return null;
}

/**
 * 从 assistant 消息中提取文本
 */
function extractText(assistantMsg: any): string | null {
  if (typeof assistantMsg.content === "string") {
    return assistantMsg.content.trim();
  }
  if (Array.isArray(assistantMsg.content)) {
    const texts: string[] = [];
    for (const block of assistantMsg.content) {
      if (block.type === "text") {
        texts.push(block.text ?? "");
      }
    }
    return texts.join("\n").trim() || null;
  }
  if (assistantMsg.content?.text) {
    return assistantMsg.content.text.trim();
  }
  return null;
}
```

---

## 附录 B: 关键类型

```typescript
interface WeixinMessage {
  message_id?: number;
  from_user_id: string;
  to_user_id: string;
  create_time_ms?: number;
  session_id?: string;
  message_type: number;
  item_list: MessageItem[];
  context_token?: string;
}

interface UserContext {
  userId: string;
  contextToken: string;
  displayName: string;
  lastMessageId?: number;
}

interface WechatMeta {
  requestId: string;
  userId: string;
  timestamp: number;
}

type ConnectionState = 
  | "disconnected" 
  | "connecting" 
  | "connected" 
  | "error" 
  | "needs_relogin";
```

---

## 附录 C: 事件对照表

| 事件 | 触发时机 | WeChat 处理 |
|------|---------|------------|
| `session_start` | 会话启动 | 加载状态，启动轮询 |
| `session_shutdown` | 会话结束 | 停止轮询，清理状态 |
| `before_agent_start` | AI 开始前 | 识别 WeChat，保存 requestId/userId |
| `message_start` | AI 开始生成消息 | 启动 typing keepalive |
| `message_end` | AI 消息生成结束 | 停止 typing keepalive |
| `agent_end` | AI 完成 | 提取回复，发送回微信，处理队列 |
| `context` | 发送给 LLM 前 | 可追加 system prompt |

---

## 附录 D: 测试清单

1. 同一用户连续发 3 条消息（队列是否顺序处理）
2. 两个用户几乎同时发消息（是否串话或 typing 错乱）
3. 长推理时 typing 是否持续显示（keepalive 是否工作）
4. tool call 场景是否只发最终回复
5. session expired (-14) 后通知 + 需要重新登录
6. agent_end 多次触发是否防重
7. 长时间推理（>30秒）typing 是否持续
