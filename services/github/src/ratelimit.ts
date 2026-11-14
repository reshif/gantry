/**
 * Per-installation write limiter (spec 11.6): a token bucket whose waiters are served in order, so a burst of blob writes from one publish
 * cannot starve another installation, and GitHub's content-creation limits are not approached.
 */
export class WriteLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number; tail: Promise<void> }>();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Runs `fn` once a write slot for this installation is free. */
  async write<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, at: this.now(), tail: Promise.resolve() }; this.buckets.set(key, b); }
    const bucket = b;
    const turn = bucket.tail.then(async () => {
      for (;;) {
        const t = this.now();
        bucket.tokens = Math.min(this.burst, bucket.tokens + ((t - bucket.at) / 60_000) * this.perMinute);
        bucket.at = t;
        if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
        await this.sleep(Math.ceil(((1 - bucket.tokens) / this.perMinute) * 60_000));
      }
    });
    bucket.tail = turn.catch(() => undefined);
    await turn;
    return fn();
  }
}
