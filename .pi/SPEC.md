# Pi WeChat Extension - 技术规格文档

> **文档版本**: v1.4 
> **最后更新**: 2026-04-07  
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
│   └── login.ts         # 扫码登录
├── media/
│   └── media-download.ts
├── storage/
│   └── state.ts        # token、context-token、sync-buf
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
  
  // UI 通知函数（从 session_start 注入）
  private notify: (message: string, level: string) => void = () => {};
  
  setNotifyFn(fn: (message: string, level: string) => void): void {
    this.notify = fn;
  }
  
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
    this.pendingMessages.clear();
    this.processedRequests.clear();
    this.currentUserId = null;
    this.currentRequestId = null;
    this.isAiProcessing = false;
    this.cleanupCounter = 0;
    this.abortController = new AbortController(); // 重建（新 abort signal）
  }
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
4. 下载媒体 → 持久化路径
    ↓
5. 格式化消息：`__WECHAT_REQ_{id}__[WeChat; user] content`
    ↓
6. 写入 wechat_meta 隐藏消息：`pi.appendEntry("wechat_meta", { requestId, userId, timestamp })`
    ↓
7. pi.sendUserMessage(formatted, { deliverAs: "followUp" })
    ↓
8. ⚠️ v0.65.2 时序问题：agent_end 回调需用 setTimeout(10) 延迟调用 sendUserMessage
    ↓
8. AI 开始生成 → before_agent_start → 发送 typing=1
    ↓
9. AI 生成完成 → turn_end → 发送 typing=2
    ↓
10. agent_end 拦截 → 从 wechat_meta 查找 requestId → 提取回复 → 发送
    ↓
11. processNextMessage() 处理队列中的下一条
```

---

## 4. 事件处理（核心）

### 4.1 session_start：初始化

```typescript
pi.on("session_start", async (_event, ctx) => {
  // 注入 UI 通知函数
  engine.setNotifyFn((msg, level) => ctx.ui.notify(msg, level as any));
  
  // 加载存储的 context tokens
  const contextTokens = await storage.loadContextTokens();
  for (const [userId, data] of Object.entries(contextTokens)) {
    engine.userContexts.set(userId, { 
      userId, 
      contextToken: data.contextToken,
      displayName: data.displayName ?? userId 
    });
  }
  
  // 加载 sync cursor
  const cursor = await storage.loadSyncCursor();
  engine.state.syncCursor = cursor;
  
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

### 4.3 before_agent_start：识别 WeChat 触发 + 发送 typing

**关键**：通过 prompt 正则匹配判断是否是 WeChat 消息（event.source 不可靠）

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 通过 prompt 正则判断是否是 WeChat 消息（event.source 在 before_agent_start 中不可用）
  const requestIdMatch = event.prompt?.match(/__WECHAT_REQ_([a-z0-9]+)__/);
  const userMatch = event.prompt?.match(/\[WeChat; ([^\]]+)\]/);
  
  // 不是 WeChat 消息，跳过
  if (!userMatch) return;
  
  const displayName = userMatch[1];
  const requestId = requestIdMatch?.[1];
  
  const userCtx = findUserContextByDisplayName(displayName);
  if (!userCtx) return;
  
  // 保存当前用户和 requestId（闭包变量，供 agent_end 使用）
  engine.currentUserId = userCtx.userId;
  engine.currentRequestId = requestId ?? null;
  
  // 发送 typing=1
  await wechatApi.sendTyping({
    ilink_user_id: userCtx.userId,
    typing_ticket: userCtx.contextToken,
    status: 1, // TYPING
  });
  
  // 返回完整 system prompt（拼接原有 + 追加内容）
  // 注意：before_agent_start 只支持 systemPrompt（完整替换），不支持 append
  return {
    systemPrompt: (event.systemPrompt || "") + `\n\n[系统] 当前正在回复微信用户: ${displayName}。请专注回复该用户。`
  };
});
```

### 4.4 turn_end：取消 typing

```typescript
pi.on("turn_end", async (event, ctx) => {
  // 只有 WeChat 触发的 turn 才发送 typing CANCEL
  if (!engine.currentRequestId) return;
  if (!engine.currentUserId) return;
  
  const userCtx = engine.userContexts.get(engine.currentUserId);
  if (!userCtx) return;
  
  await wechatApi.sendTyping({
    ilink_user_id: userCtx.userId,
    typing_ticket: userCtx.contextToken,
    status: 2, // CANCEL
  });
});
```

### 4.5 agent_end：拦截回复并发送回微信

**关键**：
1. 从 session entries 中查找 `wechat_meta` 获取 requestId（不依赖 event.source）
2. 用 `processedRequests` Map + 定期清理防止重复处理

```typescript
pi.on("agent_end", async (event, ctx) => {
  // 清理计数器
  engine.cleanupCounter++;
  
  // 获取 requestId 和 userId：优先用闭包（最快），fallback 查 entries
  // 注意：agent_end 没有 event.prompt，只能用闭包或 wechat_meta
  const requestId = engine.currentRequestId;
  let userId = engine.currentUserId;
  
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
  
  // 定期清理旧的 processedRequests
  if (engine.cleanupCounter >= 50) {
    engine.cleanupProcessedRequests();
  }
  
  const userCtx = engine.userContexts.get(userId);
  if (!userCtx) return;
  
  // 提取 AI 回复
  const assistantMsg = event.messages.find(m => m.role === "assistant");
  if (!assistantMsg) return;
  
  const replyText = extractText(assistantMsg);
  if (!replyText) return;
  
  // 发送回微信（带重试）
  try {
    await sendMessageWithRetry({
      toUserId: userCtx.userId,
      contextToken: userCtx.contextToken,
      text: replyText,
    });
  } catch (err) {
    ctx.ui.notify(`微信回复失败: ${err.message}`, "error");
  }
  
  // 重置状态（无论成功失败）
  engine.isAiProcessing = false;
  engine.currentUserId = null;
  
  // 处理队列中的下一条消息
  await engine.processNextMessage();
});
```

### 4.6 context：过滤消息（可选）

**关键**：context 事件不支持 systemPrompt，只能返回过滤后的 messages 数组

```typescript
pi.on("context", async (event, ctx) => {
  // 通过 prompt 判断是否是 WeChat 消息
  const userMatch = event.prompt?.match(/\[WeChat; ([^\]]+)\]/);
  if (!userMatch) return;
  
  // 注意：context 只支持返回 { messages }，不支持 systemPrompt
  // systemPrompt 在 before_agent_start 中已处理
  // 此处可保持 messages 不变（让 LLM 看到完整上下文）
  return { messages: event.messages };
});
```

---

## 5. 长轮询循环

### 5.1 轮询实现

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
        this.notify("微信会话已过期，请重新登录", "warning");
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

### 5.2 关键常量

```typescript
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
```

---

## 6. 消息队列处理

### 6.1 handleMessage

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
    await this.storage.saveContextToken(userId, {
      contextToken: msg.context_token,
      displayName: existing?.displayName ?? userId,
    });
  }
  
  // 格式化消息
  const formatted = this.formatWechatMessage(msg, requestId);
  
  // 如果当前正在处理该用户，加入队列
  if (this.isAiProcessing && this.currentUserId === userId) {
    const queue = this.pendingMessages.get(userId) ?? [];
    queue.push({ msg, requestId });
    this.pendingMessages.set(userId, queue);
    return;
  }
  
  // 触发 AI 处理
  await this.triggerAiForUser(userId, formatted, requestId);
}
```

### 6.2 triggerAiForUser

```typescript
async triggerAiForUser(userId: string, message: string, requestId: string): Promise<void> {
  this.currentUserId = userId;
  this.isAiProcessing = true;
  
  // 写入 wechat_meta 隐藏消息
  pi.appendEntry("wechat_meta", { requestId, userId, timestamp: Date.now() });
  
  // 注意：v0.65.2 agent_end 时序问题，用 followUp + setTimeout(10) 延迟
  await pi.sendUserMessage(message, {
    deliverAs: "followUp",
  });
}
```

### 6.3 processNextMessage

```typescript
async processNextMessage(): Promise<void> {
  // 使用 while 循环避免递归栈溢出
  while (true) {
    let processed = false;
    
    for (const [userId, queue] of this.pendingMessages) {
      if (queue.length > 0) {
        const { msg, requestId } = queue.shift()!;
        const formatted = this.formatWechatMessage(msg, requestId);
        
        try {
          await this.triggerAiForUser(userId, formatted, requestId);
        } catch (err) {
          // 触发失败，重置状态并继续
          this.isAiProcessing = false;
          this.currentUserId = null;
        }
        processed = true;
        break;
      }
    }
    
    // 没有更多消息，退出循环
    if (!processed) {
      this.isAiProcessing = false;
      return;
    }
  }
}
```

### 6.4 formatWechatMessage

```typescript
formatWechatMessage(msg: WeixinMessage, requestId: string): string {
  const userCtx = this.userContexts.get(msg.from_user_id);
  // 使用 ; 作为分隔符，避免 displayName 中包含 ] 导致正则失效
  const userLabel = `[WeChat; ${userCtx?.displayName ?? msg.from_user_id}]`;
  
  const parts: string[] = [];
  
  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case 1: // TEXT
        parts.push(item.text_item?.text ?? "");
        break;
      case 2: // IMAGE
        parts.push(`[图片: ${item.image_item?.decryptedPath ?? "unknown"}]`);
        break;
      case 3: // VOICE
        parts.push(`[语音: ${item.voice_item?.decryptedPath ?? "unknown"}]`);
        break;
      case 4: // FILE
        parts.push(`[文件: ${item.file_item?.file_name ?? "unknown"}]`);
        break;
      case 5: // VIDEO
        parts.push("[视频]");
        break;
    }
  }
  
  return `__WECHAT_REQ_${requestId}__${userLabel} ${parts.join("\n")}`;
}
```

---

## 7. sendMessage 重试机制

```typescript
async function sendMessageWithRetry(
  opts: { toUserId: string; contextToken: string; text: string },
  maxRetries: number = 3
): Promise<void> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await wechatApi.sendMessage({
        to_user_id: opts.toUserId,
        context_token: opts.contextToken,
        item_list: [{ type: 1, text_item: { text: opts.text } }],
      });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
      }
    }
  }
  
  throw lastError!;
}
```

---

## 8. 登录流程

### 8.1 状态机

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

### 8.2 QR 码显示

```typescript
async function loginWithQrCode(): Promise<WeixinAccount> {
  const qrResp = await wechatApi.getBotQrCode();
  
  const result = await ctx.ui.custom<"confirmed" | "expired" | "cancelled">(
    (tui, theme, keybindings, done) => {
      const qr = new QrCodeDisplay(qrResp.qrcode_url, theme, {
        onStatusChange: (status) => updateStatus(status),
        onEscape: () => done("cancelled"),
      });
      return qr;
    },
    { overlay: true }
  );
  
  // 轮询 get_qrcode_status...
}
```

---

## 9. Slash Command 处理

```typescript
async function handleSlashCommand(
  text: string,
  msg: WeixinMessage,
  deps: { sendTyping; sendReply }
): Promise<{ handled: boolean }> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  
  const spaceIdx = trimmed.indexOf(" ");
  const command = (spaceIdx > 0 
    ? trimmed.slice(1, spaceIdx) 
    : trimmed.slice(1)
  ).toLowerCase();
  
  switch (command) {
    case "echo": {
      const content = trimmed.slice(trimmed.indexOf(" ") + 1);
      await deps.sendReply(content);
      return { handled: true };
    }
    case "toggle-debug": {
      // 切换 debug 模式
      return { handled: true };
    }
    case "help": {
      await deps.sendReply("可用命令: /echo <text>, /toggle-debug, /help");
      return { handled: true };
    }
    default:
      return { handled: false }; // 让 AI 处理
  }
}
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
  "wxid_user_a": { "displayName": "张三", "contextToken": "ctx_xxx" },
  "wxid_user_b": { "displayName": "李四", "contextToken": "ctx_yyy" }
}
```

---

## 11. API 与工具

### 11.1 注册的工具

| 工具名 | 功能 |
|--------|------|
| `wechat_login` | 扫码登录 |
| `wechat_status` | 查看连接状态 |
| `wechat_send` | 手动发送消息 |
| `wechat_disconnect` | 断开连接 |

### 11.2 注册的命令

| 命令 | 功能 |
|------|------|
| `/wechat` | 查看状态 |
| `/wechat login` | 登录 |
| `/wechat send <user> <msg>` | 发送 |

---

## 12. 实现计划

### Phase 1: 基础框架
- [ ] 项目结构
- [ ] 复制 `api/` 模块
- [ ] 复制 `cdn/` 模块
- [ ] 复制 `media/` 模块

### Phase 2: 存储与登录
- [ ] `storage/state.ts`
- [ ] `auth/login.ts`
- [ ] QR 码 TUI 组件

### Phase 3: 核心引擎
- [ ] `wechat.ts` - 长轮询
- [ ] 事件处理（before_agent_start, turn_end, agent_end, context）
- [ ] 消息队列
- [ ] sendMessageWithRetry

### Phase 4: slash command
- [ ] `/echo`, `/toggle-debug`, `/help`

### Phase 5: 测试
- [ ] 单元测试
- [ ] 集成测试

---

## 13. 依赖

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
  "typescript": "^5.8.0",
  "vitest": "^3.1.0"
}
```

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
 * 从 event.prompt 解析 requestId
 */
function parseRequestId(prompt: string): string | null {
  return prompt.match(/__WECHAT_REQ_([a-z0-9]+)__/)?.[1] ?? null;
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
| `session_shutdown` | 会话结束 | 停止轮询 |
| `before_agent_start` | AI 开始前 | 识别 WeChat，发送 typing=1 |
| `turn_end` | turn 结束 | 发送 typing=2 |
| `agent_end` | AI 完成 | 提取回复，发送回微信 |
| `context` | 发送给 LLM 前 | 追加 system prompt |

---

## 附录 D: 测试清单

1. 同一用户连续发 3 条消息（队列是否顺序处理）
2. 两个用户几乎同时发消息（是否串话或 typing 错乱）
3. 长会话后 compaction 是否正常
4. TUI 手动输入消息时 WeChat 不应回复
5. session expired (-14) 后通知 + 需要重新登录
6. agent_end 多次触发是否防重
7. triggerAiForUser 失败后队列是否继续
