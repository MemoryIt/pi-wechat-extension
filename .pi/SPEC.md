# Pi WeChat Extension - 技术规格文档

> **文档版本**: v2.0
> **最后更新**: 2026-04-15
> **参考**: openclaw-weixin 源码 + pi coding-agent 机制

---

## 1. 概述

**项目名称**: pi-wechat-extension
**项目类型**: Pi Coding Agent Extension (pi package)
**核心功能**: 将微信接入 pi，实现"微信聊天 → AI 回复"的双向交互
**目标用户**: 希望在微信上与 AI 对话的用户

### 设计决策

| 决策项 | 选择 |
|--------|------|
| 消息交互模式 | 单主会话 + 固定前缀隔离 |
| 账号支持 | **单账号**（扫码登录） |
| AI 触发方式 | `pi.sendUserMessage(content, { deliverAs: "followUp" })` |
| WeChat 触发识别 | 通过消息前缀 `getPrefix()` 识别 |
| 状态传递 | `wechat_meta` 隐藏消息（仅 requestId）+ 闭包变量 |
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
│  │  │  (QR code)  │  │  (longpoll) │  │  (single user)  │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │  │
│  │         │                │                   │            │  │
│  │         └────────────────┼───────────────────┘            │  │
│  │                          │                                │  │
│  │  ┌──────────────────────▼────────────────────────────┐   │  │
│  │  │              wechat.ts (核心引擎)                     │   │  │
│  │  │  • singleUserId: string | null                      │   │  │
│  │  │  • singleContextToken: string | null                │   │  │
│  │  │  • currentRequestId: string | null                   │   │  │
│  │  │  • processedRequests: Map<id,timestamp> (防重复)     │   │  │
│  │  │  • typingTicketCache: { ticket, expiresAt } (60s)   │   │  │
│  │  │  • typingKeepaliveTimer: Timer | null              │   │  │
│  │  │  • pendingMessages: Array<{ msg, requestId }>       │   │  │
│  │  └───────────────────────────────────────────────────┘   │  │
│  │  ┌──────────────────────┐                                │  │
│  │  │    config.ts         │  ← 可配置的固定前缀              │  │
│  │  └──────────────────────┘                                │  │
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
├── wechat.ts             # 核心引擎（单用户版本）
├── config.ts             # 配置管理（支持文件和环境变量）
├── api/                  # HTTP API（直接复用）
│   ├── api.ts
│   ├── types.ts
│   └── session-guard.ts
├── auth/
│   └── login-qr.ts       # 扫码登录
├── media/
│   └── media-download.ts
├── storage/
│   └── state.ts          # token、context-token、sync-buf + 单用户便捷函数
├── types.ts
└── package.json
```

---

## 3. 核心设计

### 3.1 配置管理（config.ts）

支持从配置文件或环境变量读取配置：

```typescript
// 配置结构
interface WechatPluginConfig {
  prefix: string;    // 消息前缀，默认 "[wechat]"
  debug?: boolean;  // 调试模式，默认 false
}

// 配置路径: ~/.pi/agent/wechat/config.json
// 或通过环境变量 WECHAT_PREFIX 设置

// 使用示例
import { getPrefix, loadConfig } from "./config.js";

const prefix = getPrefix();  // "[wechat]" 或自定义值
```

### 3.2 闭包状态（WechatEngine 类 - 单用户版本）

```typescript
class WechatEngine {
  // === 单用户凭证（运行时加载）===
  private singleUserId: string | null = null;
  private singleContextToken: string | null = null;
  private accountId: string | null = null;
  
  // === 请求追踪（仅 requestId）===
  private currentRequestId: string | null = null;
  private processedRequests = new Map<string, number>();
  private cleanupCounter = 0;
  
  // === AI 处理状态 ===
  private isAiProcessing = false;
  
  // === 消息队列（单用户，不需要 Map）===
  private pendingMessages: Array<{ msg: WeixinMessage; requestId: string }> = [];
  
  // === Typing 相关（单用户）===
  private typingTicketCache: { ticket: string; expiresAt: number } | null = null;
  private typingKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  
  // === 初始化 ===
  async initSingleUser(): Promise<boolean> {
    const credentials = await storage.getSingleUserCredentials();
    if (!credentials) return false;
    
    this.singleUserId = credentials.userId;
    this.accountId = credentials.accountId;
    this.singleContextToken = await storage.getSingleUserContextToken();
    return true;
  }
  
  // === 清理 ===
  reset(): void {
    this.stopTypingKeepalive();
    this.typingTicketCache = null;
    this.pendingMessages = [];
    this.processedRequests.clear();
    this.currentRequestId = null;
    this.isAiProcessing = false;
    // ...
  }
}
```

### 3.3 消息格式

**旧格式（多用户）**：
```
__WECHAT_REQ_lqr5m8h2k3p1j0__[WeChat; wxid_xxx] 你好
```

**新格式（单用户）**：
```
[wechat] 你好
```

**前缀来源**：
- 配置文件 `~/.pi/agent/wechat/config.json`：`{ "prefix": "[wechat]" }`
- 或环境变量：`WECHAT_PREFIX="[wechat]"`

**requestId 生成（毫秒时间戳）**：
```typescript
private generateRequestId(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${yy}${mm}${dd}${hh}${min}${ss}${ms}`;  // 260415102904123
}
```

### 3.4 wechat_meta 结构

**旧结构（多用户）**：
```typescript
{
  requestId: string,
  userId: string,      // ← 多用户需要区分
  timestamp: number
}
```

**新结构（单用户）**：
```typescript
{
  requestId: string    // ← 仅 requestId 用于防重
}
```

### 3.5 消息处理流程

```
收到微信消息 (WeixinMessage)
    ↓
1. initSingleUser() 初始化单用户凭证
    ↓
2. 生成 requestId（毫秒时间戳）
    ↓
3. slash command 检查（/help）
    ↓ 是 → 直接回复，跳过 AI
4. 更新 singleContextToken（如消息中有）
    ↓
5. 纯图片检测：hasImage && !hasText
    ↓ 是 → 下载图片 → 保存路径 → 发送回复 → 不触发 AI
6. 格式化消息：`{prefix} {content}`
    ↓
7. 写入 wechat_meta：`pi.appendEntry("wechat_meta", { requestId })`
    ↓
8. pi.sendUserMessage(formatted, { deliverAs: "followUp" })
    ↓
9. message_start → startTypingKeepalive()
    ↓
10. AI 生成中...
    ↓
11. message_end → stopTypingKeepalive()
    ↓
12. agent_end → 提取最后一条回复 → sendMessageWithRetry()
    ↓
13. onAiDone() → 处理队列中的下一条
```

---

## 4. 事件处理（单用户版本）

### 4.1 session_start

```typescript
pi.on("session_start", async (_event, ctx) => {
  // 注册 footer 回调获取 Git 分支
  ctx.ui.setFooter((tui, theme, footerData) => { /* ... */ });
  
  const token = await getDefaultAccountToken();
  if (token) {
    setConfig({ baseUrl: token.baseUrl, token: token.botToken });
    engine.startPolling({ baseUrl: token.baseUrl, token: token.botToken });
  }
});
```

### 4.2 before_agent_start（简化）

```typescript
pi.on("before_agent_start", async (event, _ctx) => {
  const prefix = getPrefix();
  if (!event.prompt?.includes(prefix)) return;
  
  // 单用户直接使用闭包变量，无需正则提取 userId
  const requestId = engine.getCurrentRequestId();
  if (requestId) {
    console.log(`[Wechat] before_agent_start: WeChat message, requestId=${requestId}`);
  }
});
```

### 4.3 message_start / message_end

```typescript
pi.on("message_start", async () => {
  await engine.startTypingKeepalive();  // 无需传 userId
});

pi.on("message_end", async () => {
  await engine.stopTypingKeepalive();
});
```

### 4.4 agent_end

```typescript
pi.on("agent_end", async (event, ctx) => {
  setTimeout(async () => {
    const requestId = engine.getCurrentRequestId();
    if (!requestId) {
      engine.onAiDone();
      return;
    }
    
    // 防重
    if (engine.isRequestProcessed(requestId)) return;
    engine.markRequestProcessed(requestId);
    
    // 提取最后一条 assistant 回复
    const replyText = extractLastReply(event.messages);
    if (!replyText) {
      engine.onAiDone();
      return;
    }
    
    // 追加元信息
    const finalReply = replyText + buildMetaInfoSuffix(ctx);
    
    // 发送回复（使用单用户凭证）
    await engine.sendMessageWithRetry(finalReply);
    
    engine.onAiDone();
  }, 20);
});
```

---

## 5. Typing 机制（单用户）

### 5.1 核心逻辑

```
message_start → startTypingKeepalive()
                    ↓
              发送 typing=1
                    ↓
              setInterval(8秒) → 刷新 typing=1
                    ↓
message_end → stopTypingKeepalive()
                    ↓
              clearInterval
```

### 5.2 实现（单用户）

```typescript
// typing_ticket 获取（单用户）
async getTypingTicket(): Promise<string | null> {
  if (!this.singleUserId || !this.singleContextToken) return null;
  
  // 检查缓存（60秒）
  if (this.typingTicketCache && Date.now() < this.typingTicketCache.expiresAt) {
    return this.typingTicketCache.ticket;
  }
  
  // 调用 getConfig API
  const configResp = await getConfig({
    ilinkUserId: this.singleUserId,
    contextToken: this.singleContextToken,
  });
  
  if (configResp.ret === 0 && configResp.typing_ticket) {
    this.typingTicketCache = { ticket: configResp.typing_ticket, expiresAt: Date.now() + 60000 };
    return configResp.typing_ticket;
  }
  return null;
}

// startTypingKeepalive（单用户）
async startTypingKeepalive(): Promise<void> {
  await this.stopTypingKeepalive();
  await this.sendTypingStatus(1);
  
  this.typingKeepaliveTimer = setInterval(() => {
    this.sendTypingStatus(1);
  }, 8000);
}
```

---

## 6. 长轮询循环

```typescript
async startPolling(opts): Promise<void> {
  // 初始化单用户凭证
  if (!await this.initSingleUser()) return;
  
  // 加载 sync cursor
  this.state.syncCursor = await storage.loadSyncCursor(this.accountId);
  
  while (!this.abortController.signal.aborted) {
    try {
      const updates = await getUpdates({
        get_updates_buf: this.state.syncCursor,
        timeoutMs: 35000,
      });
      
      for (const msg of updates.msgs ?? []) {
        await this.handleMessage(msg, opts);
      }
      
      this.state.syncCursor = updates.get_updates_buf;
      await storage.saveSyncCursor(this.accountId, this.state.syncCursor);
      this.consecutiveFailures = 0;
      
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.state.connectionState = "needs_relogin";
        return;
      }
      this.consecutiveFailures++;
      await sleep(Math.min(2000 * this.consecutiveFailures, 30000));
    }
  }
}
```

---

## 7. 消息队列处理（单用户）

### 7.1 简化结构

```typescript
// 单用户：不需要 Map
private pendingMessages: Array<{ msg: WeixinMessage; requestId: string }> = [];

// 触发 AI
async triggerAi(msg, requestId, opts): Promise<void> {
  if (this.isAiProcessing) {
    this.pendingMessages.push({ msg, requestId });
    return;
  }
  await this.triggerAiInternal(msg, requestId, opts);
}

// AI 完成
onAiDone(): void {
  this.isAiProcessing = false;
  if (this.pendingMessages.length > 0) {
    this.safelyTriggerNext();
  }
}
```

---

## 8. 持久化存储

### 8.1 目录结构

```
~/.pi/agent/wechat/
├── accounts.json
├── config.json            # ← 新增：插件配置
└── accounts/
    └── {accountId}/
        ├── token.json          # chmod 600
        ├── context-tokens.json
        └── sync.json
```

### 8.2 新增单用户便捷函数

```typescript
// storage/state.ts

// 获取单用户凭证
async getSingleUserCredentials(): Promise<{
  botToken: string;
  accountId: string;
  userId: string;
  baseUrl: string;
} | null> {
  const token = await getDefaultAccountToken();
  if (!token) return null;
  return {
    botToken: token.botToken,
    accountId: token.accountId,
    userId: token.userId,
    baseUrl: token.baseUrl,
  };
}

// 获取单用户 contextToken
async getSingleUserContextToken(): Promise<string | null> {
  const accounts = await listAccounts();
  if (accounts.length === 0) return null;
  accounts.sort((a, b) => b.loginAt - a.loginAt);
  const tokens = await loadContextTokens(accounts[0].accountId);
  const userIds = Object.keys(tokens);
  if (userIds.length === 0) return null;
  return tokens[userIds[0]].contextToken;
}
```

---

## 9. API 与工具

### 9.1 注册的命令

| 命令 | 功能 |
|------|------|
| `/wechat login` | 扫码登录微信 |
| `/wechat logout` | 登出微信 |
| `/wechat status` | 查看连接状态 |
| `/wechat start` | 手动启动轮询 |
| `/wechat stop` | 手动停止轮询 |

---

## 10. 依赖

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

## 附录 A: 配置示例

### 配置文件 `~/.pi/agent/wechat/config.json`

```json
{
  "prefix": "[wechat]",
  "debug": false
}
```

### 环境变量

```bash
# 设置消息前缀
export WECHAT_PREFIX="[wechat]"

# 启用调试模式
export WECHAT_DEBUG="true"
```

---

## 附录 B: 测试覆盖

| 模块 | 测试文件 | 测试数 |
|------|----------|--------|
| 配置管理 | config.test.ts | 12 |
| 存储模块 | storage/storage.test.ts | 9 |
| 核心引擎 | wechat.test.ts | 27 |
| **总计** | | **48** |

---

## 附录 C: 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.0 | 2026-04-15 | 单用户模式重构：删除多用户逻辑，简化消息格式为 `{prefix} {content}`，requestId 改为毫秒时间戳，wechat_meta 仅保留 requestId |
| v1.6 | 2026-04-13 | 图片消息支持 |
| v1.5 | 2026-04-12 | Typing 状态修复、模型元信息 |
| v1.4 | 2026-04-11 | 只发最后一条消息修复 |
| v1.3 | 2026-04-10 | 消息队列时序问题修复 |
| v1.0 | 2026-04-10 | 初始版本 |
