/**
 * Per-vendor concurrency cap plus a cooldown honouring vendor rate-limit signals (429/529 with Retry-After).
 * A call acquires a slot before it is forwarded. While a vendor is cooling down, new calls wait for the cooldown when it is shorter
 * than the wait budget, and are refused with the remaining time otherwise, so runners back off instead of hammering the vendor.
 */
export type Acquire = { ok: true; release: () => void } | { ok: false; retryAfterSeconds: number; reason: "busy" | "cooldown" };

interface VendorState {
  active: number;
  waiters: Array<() => void>;
  pausedUntil: number;
}

export class VendorLimiter {
  private readonly vendors = new Map<string, VendorState>();
  constructor(
    private readonly max: number,
    private readonly waitMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private st(v: string): VendorState {
    let s = this.vendors.get(v);
    if (!s) this.vendors.set(v, (s = { active: 0, waiters: [], pausedUntil: 0 }));
    return s;
  }

  /** A vendor asked us to back off. */
  pause(vendor: string, seconds: number): void {
    const s = this.st(vendor);
    s.pausedUntil = Math.max(s.pausedUntil, this.now() + Math.min(Math.max(seconds, 0), 300) * 1000);
  }

  /** Ends a cooldown early (operator action, tests). */
  clearCooldown(vendor: string): void {
    this.st(vendor).pausedUntil = 0;
  }

  inflight(vendor: string): number {
    return this.vendors.get(vendor)?.active ?? 0;
  }

  async acquire(vendor: string): Promise<Acquire> {
    const s = this.st(vendor);
    const deadline = this.now() + this.waitMs;
    const cool = s.pausedUntil - this.now();
    if (cool > 0) {
      if (cool > this.waitMs) return { ok: false, retryAfterSeconds: Math.ceil(cool / 1000), reason: "cooldown" };
      await new Promise((r) => setTimeout(r, cool));
    }
    while (s.active >= this.max) {
      const left = deadline - this.now();
      if (left <= 0) return { ok: false, retryAfterSeconds: 1, reason: "busy" };
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          s.waiters = s.waiters.filter((w) => w !== wake);
          resolve(false);
        }, left);
        const wake = (): void => {
          clearTimeout(t);
          resolve(true);
        };
        s.waiters.push(wake);
      });
      if (!ok) return { ok: false, retryAfterSeconds: 1, reason: "busy" };
    }
    s.active++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        s.active--;
        s.waiters.shift()?.();
      },
    };
  }
}
