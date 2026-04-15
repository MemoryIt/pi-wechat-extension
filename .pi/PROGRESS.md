# Pi WeChat Extension 开发进度

## 已完成
- 设计文档 v2.0 完成
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
- **回复追加模型元信息（目录、分支、Token、百分比，成本、模型）** ✅
- **Phase 6: 单用户模式重构（删除多用户逻辑）** ✅

---

## Feature: 单用户模式重构 (2026-04-15)

**目标**：将系统从多用户改为仅支持单用户，简化代码结构

### 主要变更

| 变更项 | 旧实现 | 新实现 |
|--------|--------|--------|
| 消息格式 | `__WECHAT_REQ_xxx__[WeChat; userId] content` | `[wechat] content` |
| requestId | 36进制+随机（16字符） | 毫秒时间戳（14-17字符） |
| wechat_meta | `{ requestId, userId, timestamp }` | `{ requestId }` |
| 用户上下文 | `Map<userId, Context>` | `singleUserId`, `singleContextToken` |
| 消息队列 | `Map<userId, Queue>` | `Array<QueueItem>` |
| 前缀配置 | 硬编码 `[WeChat; ...]` | 配置文件或环境变量 |

### 新增模块

#### config.ts - 配置管理
- 支持配置文件 `~/.pi/agent/wechat/config.json`
- 支持环境变量 `WECHAT_PREFIX`
- 配置缓存机制

```typescript
// 使用示例
import { getPrefix, loadConfig } from "./config.js";

const prefix = getPrefix();  // "[wechat]"
```

#### storage/state.ts - 新增便捷函数
- `getSingleUserCredentials()` - 获取单用户凭证
- `getSingleUserContextToken()` - 获取单用户 contextToken
- `getSingleUserId()` - 获取单用户 ID

### 删除的多用户逻辑

| 删除项 | 说明 |
|--------|------|
| `userContexts: Map` | 单用户不需要 Map |
| `pendingMessages: Map` | 简化为 `Array` |
| `typingTicketCache: Map` | 简化为单个对象 |
| `typingKeepaliveTimers: Map` | 简化为单个定时器 |
| `findUserContextByDisplayName()` | 不再需要 |
| `loadPersistedContextTokens()` | 合并到 `initSingleUser()` |
| 正则匹配 userId | 简化为前缀检测 |

### 代码统计

```
  config.ts          |  94 +++++
  storage/state.ts   |  64 ++++
  wechat.ts          | -949 +++++++++++++++++----
  index.ts           | -477 +++++++++----
  ---------------------
  Net: -1268 lines
```

### 测试覆盖

| 测试文件 | 测试数 | 状态 |
|----------|--------|------|
| config.test.ts | 12 | ✅ |
| storage/storage.test.ts | 9 | ✅ |
| wechat.test.ts | 27 | ✅ |
| **总计** | **48** | ✅ **全部通过** |

### 修改文件

1. **config.ts** (新增) - 配置管理模块
2. **config.test.ts** (新增) - 配置模块测试
3. **storage/state.ts** - 新增 3 个单用户便捷函数
4. **storage/storage.test.ts** (新增) - 存储模块测试
5. **wechat.ts** - 完全重构为单用户版本
6. **wechat.test.ts** - 完全重构
7. **index.ts** - 简化事件处理
8. **tsconfig.json** - 排除测试文件

### 验证

- ✅ 单元测试全部通过（48 个测试）
- ✅ TypeScript 编译通过
- ✅ 代码逻辑简化，可维护性提升

---

## Bug Fix: 消息队列时序问题 (2026-04-10)

**问题**：微信用户连发多条消息时，只能收到第一条回复，后续消息报错

**修复方案**：
- 用 safelyTriggerNext() 替代 processNextMessage()
- setTimeout(20ms) + 指数退避（20→30→45ms）
- 重试机制：最多 3 次

**验证**：微信连发 3 条消息，正常顺序回复，无报错 ✅

---

## Bug Fix: 只发最后一条消息 (2026-04-11)

**问题**：Tool call 场景下，微信端只能看到第一条回复，看不到最终回复

**修复方案**：
- 从后往前遍历，找到最后一个有内容的 assistant 消息
- agent_end 在发送回复后处理队列

---

## Bug Fix: Typing 状态修复 (2026-04-12)

**问题**：
1. 直接使用 context_token 作为 typing_ticket 不正确
2. 单次推理时间过长，typing 会提前消失

**修复方案**：
1. 新增 getTypingTicket() 方法：调用 getConfig API 获取 typing_ticket（带 60 秒缓存）
2. 使用 typing_ticket 发送 typing 状态
3. message_start 到 message_end 之间，每 8 秒刷新一次 typing=1（keepalive）

---

## Feature: 回复追加模型元信息 (2026-04-12)

**格式**：
```
/path/to/dir (branch)
0.7%/205k $0.001 (provider) model-id
```

---

## Feature: 图片消息支持 (2026-04-13)

**实现功能**：
1. 图片下载：AES-128-ECB 解密
2. 纯图片拦截：无文本的图片消息直接返回保存路径
3. 路径共享：使用 pi.sendMessage 把路径加入会话历史

---

## Open Issues

- [ ] Slash Command：/echo, /toggle-debug, /help
- [ ] 人工测试：单用户模式重构后的功能验证

---

## Bug: 纯图片消息在 AI 处理中时被拦截

**发现日期**: 2026-04-13

**问题描述**：
当用户发送纯图片时，如果 pi 正在处理上一条消息，纯图片会被立即拦截并发送回复。

**解决方案**：
在单用户重构中，此问题依然存在，建议后续迭代解决：
1. 检测 AI 是否空闲，如果忙碌则将纯图片加入队列
2. 延迟处理纯图片消息

**优先级**: P2
