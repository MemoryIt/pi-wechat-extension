/**
 * queue.ts - 轮次队列（纯状态容器）
 *
 * 从 wechat.ts 中抽出的队列 / 忙闲 / 去重状态，不依赖任何外部模块，
 * 便于单测。语义与抽取前逐一对应：
 * - pending          : 待处理消息（FIFO）
 * - busy             : 等价于原 isAiProcessing
 * - currentRequestId : 当前正在处理的 requestId
 * - processed        : 已处理 requestId -> 时间戳（防重）
 * - cleanupCounter   : 每 50 次 markRequestProcessed 触发一次清理
 */
export class TurnQueue<T = unknown> {
  private pending: T[] = [];
  private busy = false;
  private currentRequestId: string | null = null;
  private processed = new Map<string, number>();
  private cleanupCounter = 0;

  get size(): number {
    return this.pending.length;
  }

  isBusy(): boolean {
    return this.busy;
  }

  setBusy(value: boolean): void {
    this.busy = value;
  }

  getCurrentRequestId(): string | null {
    return this.currentRequestId;
  }

  setCurrentRequestId(id: string | null): void {
    this.currentRequestId = id;
  }

  enqueue(item: T): void {
    this.pending.push(item);
  }

  dequeue(): T | undefined {
    return this.pending.shift();
  }

  isRequestProcessed(id: string): boolean {
    return this.processed.has(id);
  }

  markRequestProcessed(id: string): void {
    this.processed.set(id, Date.now());
    this.cleanupCounter++;

    if (this.cleanupCounter >= 50) {
      this.cleanupProcessedRequests();
    }
  }

  cleanupProcessedRequests(): void {
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, timestamp] of this.processed) {
      if (timestamp < oneHourAgo) {
        this.processed.delete(id);
      }
    }
    this.cleanupCounter = 0;
  }

  reset(): void {
    this.pending = [];
    this.busy = false;
    this.currentRequestId = null;
    this.processed.clear();
    this.cleanupCounter = 0;
  }
}
