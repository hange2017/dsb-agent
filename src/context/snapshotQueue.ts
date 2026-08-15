/**
 * SnapshotQueue —— 冷存储异步批量写队列。
 * enqueue O(1) 永不 await;debounce / 批量阈值 / flushNow / drain 触发落盘。
 * flush 失败重试一次后 drop + warn(fail-open)。
 */

export interface SnapshotQueueOptions<T> {
  debounceMs?: number;
  batchSize?: number;
  flush: (batch: T[]) => Promise<void>;
  onDrop?: (err: unknown, batch: T[]) => void;
}

export class SnapshotQueue<T> {
  private readonly debounceMs: number;
  private readonly batchSize: number;
  private readonly flushImpl: (batch: T[]) => Promise<void>;
  private readonly onDrop?: (err: unknown, batch: T[]) => void;
  private pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(opts: SnapshotQueueOptions<T>) {
    this.debounceMs = opts.debounceMs ?? 50;
    this.batchSize = opts.batchSize ?? 16;
    this.flushImpl = opts.flush;
    this.onDrop = opts.onDrop;
  }

  /** O(1) 入队;达到 batchSize 立即 flush,否则 debounce。 */
  enqueue(item: T): void {
    this.pending.push(item);
    if (this.pending.length >= this.batchSize) {
      void this.flushNow();
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, this.debounceMs);
  }

  /** 立刻冲刷当前 pending(含取消 debounce)。串行化:等 in-flight 结束后再刷,避免并发 append 错位。 */
  async flushNow(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // 先等上一轮结束,再取 pending(期间新入队的仍可累积)
    while (this.inFlight) {
      await this.inFlight;
    }
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      const run = this.runFlush(batch);
      this.inFlight = run;
      try {
        await run;
      } finally {
        if (this.inFlight === run) this.inFlight = undefined;
      }
    }
  }

  /** 等待 in-flight + pending 全部结束。 */
  async drain(): Promise<void> {
    await this.flushNow();
    if (this.inFlight) await this.inFlight;
  }

  /** 丢弃 pending(不写盘);in-flight 不受影响。用于整文件重写前取消未刷队列。 */
  discardPending(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }

  private async runFlush(batch: T[]): Promise<void> {
    try {
      await this.flushImpl(batch);
    } catch (err) {
      try {
        await this.flushImpl(batch);
      } catch (err2) {
        this.onDrop?.(err2, batch);
      }
    }
  }
}
