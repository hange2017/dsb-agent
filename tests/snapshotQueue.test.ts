import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SnapshotQueue } from "../src/context/snapshotQueue";

describe("SnapshotQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues without awaiting and flushes after debounce", async () => {
    const flushed: string[][] = [];
    const q = new SnapshotQueue<string>({
      debounceMs: 50,
      batchSize: 16,
      flush: async (batch) => {
        flushed.push([...batch]);
      },
    });
    q.enqueue("a");
    q.enqueue("b");
    expect(flushed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("flushes immediately when batch size is reached", async () => {
    const flushed: string[][] = [];
    const q = new SnapshotQueue<string>({
      debounceMs: 50,
      batchSize: 2,
      flush: async (batch) => {
        flushed.push([...batch]);
      },
    });
    q.enqueue("a");
    q.enqueue("b");
    await Promise.resolve();
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("flushNow drains pending items", async () => {
    const flushed: string[][] = [];
    const q = new SnapshotQueue<string>({
      debounceMs: 5000,
      batchSize: 100,
      flush: async (batch) => {
        flushed.push([...batch]);
      },
    });
    q.enqueue("x");
    await q.flushNow();
    expect(flushed).toEqual([["x"]]);
  });

  it("retries once on flush failure then drops", async () => {
    const warns: string[] = [];
    let calls = 0;
    const q = new SnapshotQueue({
      debounceMs: 10,
      batchSize: 10,
      flush: async () => {
        calls++;
        throw new Error("disk full");
      },
      onDrop: (err) => warns.push(String(err)),
    });
    q.enqueue("z");
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(warns).toHaveLength(1);
  });

  it("drain waits for in-flight flush", async () => {
    let resolveFlush!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFlush = r;
    });
    let finished = false;
    const q = new SnapshotQueue({
      debounceMs: 1,
      batchSize: 10,
      flush: async () => {
        await gate;
        finished = true;
      },
    });
    q.enqueue("w");
    await vi.advanceTimersByTimeAsync(1);
    const drainP = q.drain();
    expect(finished).toBe(false);
    resolveFlush();
    await drainP;
    expect(finished).toBe(true);
  });

  it("serializes overlapping batchSize flushes", async () => {
    vi.useRealTimers();
    const active = { n: 0, max: 0 };
    const flushed: number[] = [];
    const q = new SnapshotQueue<number>({
      debounceMs: 50,
      batchSize: 4,
      flush: async (batch) => {
        active.n++;
        active.max = Math.max(active.max, active.n);
        await new Promise((r) => setTimeout(r, 20));
        flushed.push(batch.length);
        active.n--;
      },
    });
    for (let i = 0; i < 12; i++) q.enqueue(i);
    await q.drain();
    expect(active.max).toBe(1);
    expect(flushed.reduce((a, b) => a + b, 0)).toBe(12);
  });
});
