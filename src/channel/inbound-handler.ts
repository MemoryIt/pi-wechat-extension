/**
 * channel/inbound-handler.ts - 入站消息处理器
 *
 * 从 `Channel.handleMessage` 抽出的入站处理协作类：生成 requestId、按需同步
 * `contextToken`（失效 typing ticket + 条件持久化），最后派发给 `MessageRouter`。
 * 作为 `PollingLoop.onMessage` 的目标，使 poller 的两个构造期回调都不再指回
 * `Channel`。
 *
 * 依赖方向：只依赖 `ports/types`（协议类型）、`shared/types`（API 选项）、
 * `storage/state`（持久化）、`./state`、`./request-id`、`shared/logger`，
 * 不感知 `Channel` 编排器。
 */

import type { WeixinMessage } from "../ports/types.js";
import type { WechatApiOpts } from "../shared/types.js";
import * as storage from "../storage/state.js";
import type { ChannelState } from "./state.js";
import type { RequestIdGenerator } from "./request-id.js";
import type { PluginLogger } from "../shared/logger.js";

/** 最小依赖（窄接口，便于单测注入）。 */
export interface InboundTyping {
  invalidateTicket(): void;
}

export interface InboundDispatch {
  dispatch(msg: WeixinMessage, requestId: string, opts: WechatApiOpts): Promise<void>;
}

export interface InboundHandlerDeps {
  state: ChannelState;
  typing: InboundTyping;
  router: InboundDispatch;
  requestId: RequestIdGenerator;
  logger: PluginLogger;
}

export class InboundHandler {
  constructor(private readonly deps: InboundHandlerDeps) {}

  /**
   * 处理收到的微信消息：contextToken 更新 / 触发 turn。
   *
   * 顺序契约：
   * 1. 先生成 requestId；
   * 2. 若 `msg.context_token` 非空且与当前 `state.contextToken` 不同：debug 日志 →
   *    写 `state.contextToken` → `typing.invalidateTicket()` → 仅当 accountId/userId
   *    齐全时 `storage.saveContextToken(...)`；
   * 3. 最后 `router.dispatch(msg, requestId, opts)`。
   */
  async handle(msg: WeixinMessage, opts: WechatApiOpts): Promise<void> {
    // 单用户模式下，忽略消息来源（固定发给单用户）
    const requestId = this.deps.requestId.next();

    // 更新 contextToken（如果消息中有）
    if (msg.context_token && msg.context_token !== this.deps.state.contextToken) {
      this.deps.logger.debug(`Updating contextToken from message`);
      this.deps.state.contextToken = msg.context_token;
      // contextToken 变化后旧 typing ticket 立即失效
      this.deps.typing.invalidateTicket();
      // 持久化
      if (this.deps.state.accountId && this.deps.state.userId) {
        await storage.saveContextToken(this.deps.state.accountId, this.deps.state.userId, {
          displayName: this.deps.state.userId,
          contextToken: msg.context_token,
          lastMessageAt: Date.now(),
        });
      }
    }

    // 触发 AI 处理
    await this.deps.router.dispatch(msg, requestId, opts);
  }
}

export function createInboundHandler(deps: InboundHandlerDeps): InboundHandler {
  return new InboundHandler(deps);
}
