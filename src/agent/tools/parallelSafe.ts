/** 同轮可并行执行的只读工具名(无工作区副作用)。 */
const PARALLEL_SAFE = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebSearch",
  "WebFetch",
]);

export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE.has(name);
}

/**
 * 将已通过权限的工具下标按「连续只读批 / 单条非只读」分组。
 * 只读连续段可 Promise.all;其余保持原序串行。
 */
export function partitionToolBatches(names: string[]): Array<{ start: number; end: number; parallel: boolean }> {
  const batches: Array<{ start: number; end: number; parallel: boolean }> = [];
  let i = 0;
  while (i < names.length) {
    if (isParallelSafeTool(names[i])) {
      const start = i;
      while (i < names.length && isParallelSafeTool(names[i])) i++;
      batches.push({ start, end: i, parallel: i - start > 1 });
    } else {
      batches.push({ start: i, end: i + 1, parallel: false });
      i++;
    }
  }
  return batches;
}

/** 按能力策略生成执行批:serial 或 maxParallel<=1 时全部串行。 */
export function mapParallelBatches(
  names: string[],
  opts: { mode: "read_safe" | "serial"; maxParallelTools: number },
): Array<{ start: number; end: number; parallel: boolean }> {
  if (opts.mode === "serial" || opts.maxParallelTools <= 1) {
    return names.map((_, i) => ({ start: i, end: i + 1, parallel: false }));
  }
  return partitionToolBatches(names);
}

/** 限制并发的 Promise 执行(保完成顺序由调用方按 index 写回)。 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  if (items.length === 0) return;
  if (limit === 1 || items.length === 1) {
    for (let i = 0; i < items.length; i++) await worker(items[i], i);
    return;
  }
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
