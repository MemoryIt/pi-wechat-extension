/**
 * polling.ts - 微信长轮询循环
 *
 * 负责 start/stop/reset 与连接状态维护：通过 PollingLoopDeps 反向注入宿主能力
 * （会话初始化 / 账号 / cursor 持久化 / 消息处理 / 会话过期通知 / 日志 / sleep），
 * PollingLoop 自身不直接依赖 storage、api 边界之外的模块。
 * （最初自 wechat.ts 提取，行为保持不变。）
 */

import type { WeixinMessage } from "../ports/types.js";
import type { WechatInbound } from "../ports/inbound.js";
import type { WechatApiOpts } from "../shared/types.js";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "needs_relogin";

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/**
 * 轮询中止哨兵：用于区分「主动 stopPolling」与真实网络错误。
 * 底层 getUpdates 不接受 AbortSignal，核心层改用 Promise.race 抢跑中止。
 */
export const POLL_ABORTED = Symbol("wechat-poll-aborted");

export type StartPollingOpts = WechatApiOpts;

export interface PollingLoopDeps {
  /** -> engine.initSingleUser() */
  ensureSession(): Promise<boolean>;
  getAccountId(): string | null;
  loadCursor(accountId: string): Promise<string | null>;
  saveCursor(accountId: string, cursor: string): Promise<void>;
  /** 入站端口：长轮询拉取更新 */
  inbound: WechatInbound;
  /** -> engine.handleMessage */
  onMessage(msg: WeixinMessage, opts: StartPollingOpts): Promise<void>;
  /** B4：会话过期（needs_relogin）时通知用户 */
  onNeedsRelogin(): void;
  debug(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  sleep(ms: number): Promise<void>;
}

function isSessionExpiredError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    return err.errcode === -14 || err.code === -14;
  }
  return false;
}

/**
 * 长轮询循环：负责 start/stop/reset 与连接状态。
 *
 * 重入守卫：若已有轮询会话在运行，直接返回，绝不并发第二条循环。
 * generation 令牌：reset()/新会话会让旧令牌过期，旧循环拿到过期结果后直接丢弃，
 * 避免污染新会话状态。
 */
export class PollingLoop {
  private state: {
    syncCursor: string;
    connectionState: ConnectionState;
  } = {
    syncCursor: "",
    connectionState: "disconnected",
  };

  private abortController = new AbortController();
  private consecutiveFailures = 0;
  private pollingActive = false;
  private pollingGeneration = 0;

  constructor(private readonly deps: PollingLoopDeps) {}

  get connectionState(): ConnectionState {
    return this.state.connectionState;
  }

  /**
   * 停止长轮询
   *
   * 记录停止动作（abort），使 start() 内的 Promise.race 立即抢跑退出。
   * 注意：底层 getUpdates 不接受 AbortSignal，因此在途请求仍会在后台直到超时
   * （35s）才结束；但核心层不再等待它，轮询循环会迅速退出。
   */
  stop(): void {
    this.abortController.abort();
    this.state.connectionState = "disconnected";
  }

  /**
   * 构造「收到 abort 即 reject(POLL_ABORTED)」的 promise，并返回解除监听的函数。
   */
  private createAbortWaiter(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
    let onAbort: (() => void) | null = null;
    const promise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(POLL_ABORTED);
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return {
      promise,
      dispose: () => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  /** 启动长轮询。 */
  async start(opts: StartPollingOpts): Promise<void> {
    if (this.pollingActive) {
      this.deps.debug("startPolling ignored: polling is already active");
      return;
    }
    this.pollingActive = true;
    const generation = ++this.pollingGeneration;

    // A3：同步进入 connecting，覆盖「已启动但首次 getUpdates 尚未返回」的窗口；
    // 首次成功返回后转 connected，无凭证/退出时由 finally 回落 disconnected。
    this.state.connectionState = "connecting";

    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
    const abortSignal = this.abortController.signal;

    try {
      // 初始化单用户凭证
      if (!(await this.deps.ensureSession())) {
        return;
      }
      if (generation !== this.pollingGeneration) return;

      // 加载 sync cursor
      this.state.syncCursor = (await this.deps.loadCursor(this.deps.getAccountId()!)) ?? "";

      while (!abortSignal.aborted) {
        if (generation !== this.pollingGeneration) break;

        // 在途请求与 abort 抢跑：stop() 后循环迅速退出。
        // 在途 getUpdates 仍在后台直到自身超时（底层不支持 AbortSignal）。
        const abortWaiter = this.createAbortWaiter(abortSignal);
        try {
          const updates = await Promise.race([
            this.deps.inbound.getUpdates({
              cursor: this.state.syncCursor,
              baseUrl: opts.baseUrl,
              token: opts.token,
              timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
            }),
            abortWaiter.promise,
          ]);

          if (generation !== this.pollingGeneration) break;

          for (const msg of updates.messages) {
            if (abortSignal.aborted || generation !== this.pollingGeneration) break;
            await this.deps.onMessage(msg, opts);
          }

          // 更新并持久化 cursor（缺字段回落由 inbound adapter 完成）
          this.state.syncCursor = updates.cursor;
          const accountId = this.deps.getAccountId();
          if (accountId) {
            await this.deps.saveCursor(accountId, this.state.syncCursor);
          }

          this.consecutiveFailures = 0;
          this.state.connectionState = "connected";
        } catch (error: unknown) {
          // 主动停止 / 过期会话：直接退出，不当作轮询失败
          if (error === POLL_ABORTED || abortSignal.aborted || generation !== this.pollingGeneration) {
            this.deps.debug("Polling loop aborted, exiting");
            break;
          }

          if (isSessionExpiredError(error)) {
            this.state.connectionState = "needs_relogin";
            this.deps.onNeedsRelogin();
            return;
          }

          this.consecutiveFailures++;
          this.state.connectionState = "error";
          const errMsg = error instanceof Error ? error.message : String(error);
          this.deps.error(`[Wechat] Poll error (attempt ${this.consecutiveFailures}):`, errMsg);

          const delay = Math.min(2000 * this.consecutiveFailures, 30_000);
          await this.deps.sleep(delay);
        } finally {
          abortWaiter.dispose();
        }
      }
    } finally {
      // 只有当前会话仍是最新时才释放守卫，避免旧循环误清新会话
      if (generation === this.pollingGeneration) {
        this.pollingActive = false;
        // needs_relogin 是终态：保留给 UI/用户查看，不被 disconnected 覆盖（B4）
        if (this.state.connectionState !== "needs_relogin") {
          this.state.connectionState = "disconnected";
        }
      }
    }
  }

  /**
   * 重置轮询状态：generation 过期、abort 并重建 controller、清 cursor / 连接状态 / 失败计数。
   */
  reset(): void {
    // 让旧轮询会话的 generation 过期，丢弃其后续结果
    this.pollingGeneration++;
    this.pollingActive = false;

    // 停止并重建 AbortController
    this.abortController.abort();
    this.abortController = new AbortController();

    this.consecutiveFailures = 0;
    this.state.syncCursor = "";
    this.state.connectionState = "disconnected";
  }
}
