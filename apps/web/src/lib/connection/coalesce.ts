/**
 * Trailing coalescer for SSE-driven invalidation: a burst of `change` events becomes one flush per window carrying the
 * union of the slice names. A person's own write does NOT go through here (it invalidates immediately, leading edge).
 */
export interface CoalescerOptions {
  waitMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface Coalescer {
  add(keys: readonly string[]): void;
  /** Flush what is pending now. */
  flush(): void;
  /** Drop what is pending without flushing. */
  cancel(): void;
}

export function createCoalescer(flush: (keys: string[]) => void, o: CoalescerOptions = {}): Coalescer {
  const waitMs = o.waitMs ?? 250;
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((t) => clearTimeout(t));
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    if (timer) clearT(timer);
    timer = null;
    if (!pending.size) return;
    const keys = [...pending];
    pending.clear();
    flush(keys);
  };
  return {
    add(keys) {
      for (const k of keys) pending.add(k);
      if (waitMs <= 0) return run();
      if (!timer) timer = setT(run, waitMs);
    },
    flush: run,
    cancel() {
      if (timer) clearT(timer);
      timer = null;
      pending.clear();
    },
  };
}
