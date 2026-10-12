/**
 * channel/create-channel.ts - Channel 内部装配工厂
 *
 * 把「`new` 出各协作类并互相注入回调」这段装配逻辑从 `Channel` 构造函数抽出，
 * 使 `Channel` 只负责「调用工厂 → 把结果赋给自身字段」与对外委托行为。
 *
 * 行为契约与抽取前 `Channel` 构造函数逐字等价（仅把 `this.x` 改为局部变量）：
 * - `state`：`deps.state ?? new ChannelState()`；`deps.host/config/notifier` 存在时注入。
 * - `logger`：`deps.logger ?? createLogger({ isDebugEnabled: () => isDebugEnabled() })`。
 * - `sleep`：`deps.sleep ?? defaultSleep`（仅传给 poller）。
 * - `SerialTaskQueue` / `MediaStore` / `TypingController` / `MessageSender` /
 *   `MessageRouter` / `InboundHandler` / `CredentialLoader` / `PollingLoop` 的创建与
 *   回调注入与抽取前一致。
 *
 * 依赖方向单向：只依赖 `ports/`、`storage/` 与 `shared/`；对 `ChannelDeps` 仅做
 * `import type`（避免与 `channel.ts` 形成运行时循环依赖）。
 */

import type { ChannelDeps } from "./channel.js";
import * as storage from "../storage/state.js";
import { isDebugEnabled } from "../shared/config.js";
import { sleep as defaultSleep } from "../shared/time.js";
import type { PluginLogger } from "../shared/logger.js";
import { createLogger } from "../shared/logger.js";
import { ChannelState } from "./state.js";
import { RequestIdGenerator } from "./request-id.js";
import { PollingLoop } from "./polling.js";
import { SerialTaskQueue } from "./queue.js";
import { TypingController } from "./typing.js";
import { MessageSender } from "./sender.js";
import { MessageRouter } from "./router.js";
import { MediaStore } from "./media-store.js";
import { InboundHandler } from "./inbound-handler.js";
import { createCredentialLoader } from "./credential-loader.js";
import type { CredentialLoader } from "./credential-loader.js";

/** 一次装配产出的运行时协作类集合（供 `Channel` 持有并对外委托）。 */
export interface ChannelRuntime {
  state: ChannelState;
  logger: PluginLogger;
  credentialLoader: CredentialLoader;
  poller: PollingLoop;
  typing: TypingController;
  sender: MessageSender;
  router: MessageRouter;
  inboundHandler: InboundHandler;
}

/**
 * 装配并返回 Channel 运行时协作类集合。
 *
 * 纯构造（无副作用，不启动轮询）；`Channel` 构造函数调用后把各字段赋给自身。
 */
export function createChannelRuntime(deps: ChannelDeps): ChannelRuntime {
  const state = deps.state ?? new ChannelState();
  if (deps.host) state.host = deps.host;
  if (deps.config) state.config = deps.config;
  if (deps.notifier) state.notifier = deps.notifier;

  const logger = deps.logger ?? createLogger({ isDebugEnabled: () => isDebugEnabled() });
  const sleep = deps.sleep ?? defaultSleep;
  const mediaQueue = new SerialTaskQueue((err) =>
    logger.error("Media background task failed", err),
  );

  const { inbound, outbound, media } = deps.ports;

  const mediaStore = new MediaStore({
    media,
    log: (...a: unknown[]) => logger.debug(String(a[0] ?? ""), ...a.slice(1)),
    errLog: (...a: unknown[]) => logger.error(String(a[0] ?? ""), ...a.slice(1)),
  });

  const typing = new TypingController({
    outbound,
    getContextToken: () => state.contextToken,
    debug: logger.debug.bind(logger),
    error: logger.error.bind(logger),
  });
  const sender = new MessageSender({
    outbound,
    canSend: () => state.getCredentials() !== null,
    debug: logger.debug.bind(logger),
    error: logger.error.bind(logger),
  });

  const router = new MessageRouter({
    mediaStore,
    mediaQueue,
    sender,
    getHost: () => state.host,
    getOpts: () => state.getOpts(),
    isTerminalProcessing: () => state.isTerminalMessageProcessing,
    logger,
  });

  const inboundHandler = new InboundHandler({
    state,
    typing,
    router,
    requestId: new RequestIdGenerator(),
    logger,
  });

  const credentialLoader = createCredentialLoader({
    state,
    logger,
  });

  const poller = new PollingLoop({
    ensureSession: () => credentialLoader.ensureSession(),
    getAccountId: () => state.accountId,
    loadCursor: (accountId) => storage.loadSyncCursor(accountId),
    saveCursor: (accountId, cursor) => storage.saveSyncCursor(accountId, cursor),
    inbound,
    onMessage: (msg, opts) => inboundHandler.handle(msg, opts),
    onNeedsRelogin: () => {
      logger.debug("Session expired, needs relogin");
      state.notifier?.("微信登录已失效，请执行 /wechat login 重新登录", "error");
    },
    debug: logger.debug.bind(logger),
    error: logger.error.bind(logger),
    sleep,
  });

  return {
    state,
    logger,
    credentialLoader,
    poller,
    typing,
    sender,
    router,
    inboundHandler,
  };
}
