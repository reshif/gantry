/**
 * Sampling for unauthenticated denials (unsigned or forged webhook calls). Each denial used to write one audit row, so anyone
 * on the internet could grow the hash-chained ledger at the rate limit. The sampler lets the first few rows per minute through,
 * per source and per hook overall, and counts the rest; the next row that is written carries how many were left out, so the
 * ledger still shows the attack and its size without one row per request. The HTTP answer (401) never changes.
 *
 * In memory, per API replica: a burst spread across replicas is audited a few rows per replica, which is fine for its purpose.
 */
export interface SampleResult {
  /** Write an audit row for this denial. */
  audit: boolean;
  /** Denials not audited since the last row for this key; put it on the row so nothing is silently lost. */
  suppressed: number;
}

interface Bucket {
  windowStart: number;
  written: number;
  suppressed: number;
}

export class DenialSampler {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perSource = 5,
    private readonly perHook = 30,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** `hook` names the endpoint (github, trigger:<id>, slack); `source` is the caller's address. */
  sample(hook: string, source: string, now = Date.now()): SampleResult {
    const src = this.bucket(`${hook}|${source}`, now);
    const all = this.bucket(`${hook}|*`, now);
    if (src.written >= this.perSource || all.written >= this.perHook) {
      src.suppressed++;
      all.suppressed++;
      return { audit: false, suppressed: 0 };
    }
    const suppressed = all.suppressed;
    src.written++;
    all.written++;
    src.suppressed = 0;
    all.suppressed = 0;
    return { audit: true, suppressed };
  }

  private bucket(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      b = { windowStart: now, written: 0, suppressed: 0 };
      this.buckets.set(key, b);
    } else if (now - b.windowStart >= this.windowMs) {
      // a new window: keep the count of what was left out so the next row reports it
      b.windowStart = now;
      b.written = 0;
    }
    return b;
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.windowStart >= this.windowMs && b.suppressed === 0) this.buckets.delete(k);
    // still full (a flood of distinct sources): drop the oldest half rather than grow without bound
    if (this.buckets.size >= this.maxKeys) [...this.buckets.keys()].slice(0, Math.floor(this.maxKeys / 2)).forEach((k) => this.buckets.delete(k));
  }
}

/** One sampler for the process; hooks share it so the per-hook cap holds across their sources. */
export const hookDenials = new DenialSampler();
