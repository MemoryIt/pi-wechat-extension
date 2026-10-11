# 重构档案：Ports & Adapters（2026-10-11）

本目录记录 **pi-wechat-extension** 在 2026-10-11 完成的「轻量 Ports & Adapters 薄通道」重构的
计划、实现结果与验证报告，供后续维护者追溯「为什么这么改、每一步怎么验证的」。

> 这些文档是**当时的执行工件**（任务书 / 结果 / 验证报告 / 验证指令）。它们描述了用
> implementer + verifier 两个独立子代理分阶段推进的过程，**不要求后来者照搬该流程**。

## 基本信息

| 项 | 值 |
|---|---|
| 起始基线 | `bb88b23`（重构前 `dev`） |
| 完成提交 | `45b50fb`（重构后 `dev`，S1–S9 全部 FF 合并） |
| 目标 | 把插件做成「pi 端口 ↔ 通道核心 ↔ 微信端口」的薄通道 |
| 自动测试 | 93 → **129** pass / 15 files / 0 fail |
| vendor 代码 | 全程 **零改动**（`api/ auth/ cdn/ media/ messaging/ util/`） |

## 最终架构

```
src/index.ts  组合根：createExtension() 显式组装 ChannelState + adapters + Channel + PiHost + Auth
  ├─ bridge/    pi 侧适配（注入 Channel/WechatAuth，不依赖单例）
  ├─ channel/   通道核心：Channel + state + polling/queue/router/media-store/typing/sender（只依赖 ports）
  ├─ ports/     端口接口：inbound / outbound / media / auth / pi-host / types
  ├─ adapters/  微信侧薄包装：唯一接触 vendor 的模块
  ├─ storage/   持久化
  └─ shared/    基础 + redact/file-logger 再导出边界
```

依赖方向（单向，无倒置）：`index → bridge/channel/adapters/storage`；`bridge → channel`；
`channel → ports/storage/shared`；`adapters → ports + vendor`。

## 阶段总览

| 阶段 | 内容 | 结果 |
|---|---|---|
| S1 | `ports/` 接口定义（含 `PiHost`、类型边界 `ports/types`） | ✅ |
| S2 | `adapters/` 薄包装 + `redact`/`file-logger` 边界收口 | ✅ |
| S3 | engine 改用端口 + 测试 mock 迁移到端口 fake | ✅ |
| S4 | 抽取 `ChannelState` + 修回 `sendWithRetry` 前置检查 | ✅ |
| S5 | 协作类移入 `channel/` + `Channel` 编排器 + 通道集成测试 | ✅ |
| S6 | 组合根显式 DI（`createExtension`，移除单例/`setPi`/`setConfig`） | ✅ |
| S7 | 删除 `WechatEngine` 门面与 `src/engine/`，测试迁到 `tests/channel` | ✅ |
| S8 | 文档与 C4 图同步（`engine`→`channel`，新增 `ports`/`adapters`） | ✅ |
| S9 | adapter 组装上移 `index`，消除 `channel → adapters` | ✅ |

每个阶段均：从 `dev` 切分支 → implementer 子代理实现（原子提交）→ verifier 子代理独立 worktree 只读复验 →
主代理 `git merge --ff-only` 合回 `dev`。

## 目录说明

```
docs/refactor-2026-10-11/
├── README.md                     # 本文件
├── e2e-manual-2026-10-11.md      # 人工验收清单 + 结果（含未测项与现象备注）
└── stages/
    ├── pa-N.md                   # 任务书（目标/范围/验收）
    ├── pa-N-verify.md            # 验证指令（交 verifier 的只读检查清单）
    ├── pa-N.result.md            # 实现结果（提交/测试数/scope/遗留）
    └── pa-N.verify.md            # 验证报告（逐条 acceptance + 证据）
```

## 人工验收结论（摘要）

详见 [`e2e-manual-2026-10-11.md`](./e2e-manual-2026-10-11.md)。核心链路（登录/持久化/双向文本/
turn 识别/typing/队列/媒体/文件发送/命令生命周期）均通过。已知/待观察项：

- **A3（轻微）**：重启 pi 后 `/wechat status` 可能先显示未连接（`connectionState` 在首次
  `getUpdates` 成功后才变 `connected`，长轮询超时约 35s），但收发消息正常。
- **F6（待复现）**：先发多张图片再发文本时，文本疑似被阻塞；需进一步复现定位。
- **B1（待确认）**：二维码正常显示，链接文字未显示（疑似 TUI 覆盖，功能不受影响）。
- 其余条目（F4/F8/I/J/K）为**未测**，不代表失败。

## 相关文档

- 架构说明：[`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- C4 图：[`../c4/`](../c4/)
