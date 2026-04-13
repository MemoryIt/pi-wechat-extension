# Pi-coding-agent 微信插件开发问题总结

**文档标题**：通过 `pi.sendUserMessage()` 转发消息时，消息中的 `/` 命令无法触发内置或注册命令的路由器

**作者**：基于与 Grok 的多次调试讨论  
**日期**：2026-04-12  
**Pi 版本**：v0.66.1  
**仓库**：https://github.com/MemoryIt/pi-wechat-extension  
**核心场景**：微信端发送 `/new` 或 "新会话" 等命令，希望在 Pi 端创建新会话。

## 1. 问题描述

在基于 **openclaw-weixin** 的微信插件中：

- 微信消息通过**长轮询** → `handleMessage()` → `pi.sendUserMessage(text)` 注入 Pi。
- 当用户在微信发送 `/new`、`/wechat-new` 或中文 "新会话" 时，**命令未被执行**，而是被当作普通用户消息发送给 LLM。
- LLM 通常会将 `/wechat-new` 解释为普通对话（或识别为潜在 prompt injection），并生成回复，而不是触发命令逻辑。
- 即使在微信中直接发送已注册的命令（如 `/wechat-new`），也**没有反应**。

**预期行为**：像终端直接输入 `/new` 一样，立即执行命令（创建新会话等）。  
**实际行为**：命令字符串进入 LLM 处理流程。

## 2. 已尝试的方案及结果

以下是所有尝试过的方案及其详细结果（按尝试顺序）：

### 方案 1：input 事件拦截（index.ts）

- **做法**：`pi.on("input", ...)` 监听，检测到 `/new` 等后返回 `{ action: "transform", text: "/new" }` 或 `{ action: "handled" }`。
- **结果**：**不生效**。
- **原因**：微信消息走长轮询路径，不经过 `input` 事件（或在命令检查后才可能触发，但命令已漏过）。
- **日志观察**：无 input 拦截日志。

### 方案 2：在 handleMessage 中发送 "/new" 给 LLM

- **做法**：检测关键词后 `pi.sendUserMessage("/new")`。
- **结果**：**失败**。LLM 将 `/new` 当作普通对话内容处理。
- **原因**：消息被 WeChat 插件的 `formatWechatMessage` / wrapper（`WECHAT_REQ_xxx[...]` 前缀）包装后注入。

### 方案 3：注册自定义命令 + sendUserMessage("/wechat-new")

- **做法**：
  - `pi.registerCommand("wechat-new", { handler: async (_, ctx) => { await ctx.newSession(); ... } })`
  - 微信检测到关键词后 `pi.sendUserMessage("/wechat-new")`。
- **结果**：**失败**。
  - 终端直接输入 `/wechat-new` → 成功执行 handler。
  - 通过 `sendUserMessage` 发送 → LLM 看到 "The user sent "/wechat-new" which appears to be a command..." 并开始解释，handler 从未执行，出现 "Operation aborted"。
- **关键日志**：
  - `before_agent_start: not a WeChat message, skipping`
  - LLM 开始处理命令字符串。
  - 无 "[WeChat] /wechat-new handler 执行" 日志。

### 方案 4：ctx.newSession() 直接调用

- **做法**：在 `handleMessage`、`session_start`、`before_agent_start` 或 `input` 中尝试 `currentCtx.newSession()`。
- **结果**：**失败**（`currentCtx.newSession is not a function`）。
- **原因**：`newSession()`、`fork()` 等会话控制方法**仅存在于 `ExtensionCommandContext`**（即 `registerCommand` 的 `handler` 参数中的 `ctx`）。普通事件（如 `input`、`session_start`）传入的是 `ExtensionContext`，不包含这些方法。这是官方有意设计（防止事件 handler 中调用导致死锁）。

### 方案 5：input 事件结合命令拦截（最新尝试）

- **做法**：在 `input` 中检测 `event.source === "extension"` 和关键词，返回 `{ action: "handled" }` 并尝试 `ctx.newSession()`。
- **结果**：部分生效（可拦截防止进 LLM），但 `newSession` 仍不可用。
- **原因**：`input` 事件在 **extension commands 检查之后**触发。只有终端 interactive 输入才会完整走命令路由；`sendUserMessage`（source="extension"）会跳过 slash command dispatch。

## 3. 核心结论与官方行为确认

通过官方文档（extensions.md）、GitHub issues（如 #2994、#2549、#2488、#2860 等）及源码分析，确认以下事实：

- **slash command 路由器（registerCommand 的 handler）只对终端 interactive 输入生效**。
- **`pi.sendUserMessage("/xxx")`（或 `pi.sendMessage`）故意绕过 slash command 路由器**（source = "extension"），直接将消息当作普通 user message 追加到会话历史，然后走 `input` → `before_agent_start` → LLM。
- `sendUserMessage` 的 options 仅支持 `deliverAs: "steer" | "followUp" | "nextTurn"`，**无参数**可强制走 command routing。
- `ctx.newSession()` 等方法 **仅在 ExtensionCommandContext 中可用**，普通事件上下文不可用。
- 微信插件的长轮询 + `sendUserMessage` 路径天然属于 "extension 发送消息"，因此命令无法触发。
- 这不是 bug，而是 **by design**（多个 issue 已确认并标记为设计行为）。

**处理顺序（官方文档明确）**：

1. Extension commands 检查（仅终端 interactive 输入有效；命中则跳过 input）。
2. `input` 事件（可 intercept/transform/handled）。
3. Skill / template 展开。
4. LLM 处理。
