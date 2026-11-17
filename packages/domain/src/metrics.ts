/**
 * Prometheus text-format metrics, dependency free, shared by the API, the worker and the launcher.
 * Also the one access rule for scraping: the internal network, or a bearer token. No node imports (the web app shares this package).
 */

export type Labels = Readonly<Record<string, string>>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmt = (n: number): string => (Number.isNaN(n) ? "NaN" : n === Infinity ? "+Inf" : n === -Infinity ? "-Inf" : String(n));
/** Series per metric are capped, so a label that follows user input can never grow memory without limit. */
const MAX_SERIES = 500;

function key(labels: Labels | undefined): string {
  if (!labels) return "";
  return Object.keys(labels).sort().map((k) => `${k}="${esc(String(labels[k]))}"`).join(",");
}

interface Family { name: string; help: string; type: "counter" | "gauge" | "histogram"; lines(): string[] }

export class Counter implements Family {
  readonly type = "counter" as const;
  private readonly v = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels?: Labels, by = 1): void {
    const k = key(labels);
    if (!this.v.has(k) && this.v.size >= MAX_SERIES) return;
    this.v.set(k, (this.v.get(k) ?? 0) + by);
  }
  lines(): string[] {
    return [...this.v].map(([k, n]) => `${this.name}${k ? `{${k}}` : ""} ${fmt(n)}`);
  }
}

export class Gauge implements Family {
  readonly type = "gauge" as const;
  private readonly v = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(value: number, labels?: Labels): void {
    const k = key(labels);
    if (!this.v.has(k) && this.v.size >= MAX_SERIES) return;
    this.v.set(k, value);
  }
  clear(): void {
    this.v.clear();
  }
  lines(): string[] {
    return [...this.v].map(([k, n]) => `${this.name}${k ? `{${k}}` : ""} ${fmt(n)}`);
  }
}

export class Histogram implements Family {
  readonly type = "histogram" as const;
  private readonly v = new Map<string, { counts: number[]; sum: number; n: number }>();
  constructor(readonly name: string, readonly help: string, private readonly buckets: readonly number[]) {}
  observe(value: number, labels?: Labels): void {
    const k = key(labels);
    let s = this.v.get(k);
    if (!s) {
      if (this.v.size >= MAX_SERIES) return;
      s = { counts: this.buckets.map(() => 0), sum: 0, n: 0 };
      this.v.set(k, s);
    }
    const series = s;
    this.buckets.forEach((b, i) => {
      if (value <= b) series.counts[i]! += 1;
    });
    series.sum += value;
    series.n += 1;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.v) {
      const sep = k ? `${k},` : "";
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${sep}le="${fmt(b)}"} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.n}`, `${this.name}_sum${k ? `{${k}}` : ""} ${fmt(s.sum)}`, `${this.name}_count${k ? `{${k}}` : ""} ${s.n}`);
    }
    return out;
  }
}

export const LATENCY_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class MetricsRegistry {
  private readonly families = new Map<string, Family>();
  private readonly collectors: Array<() => void | Promise<void>> = [];

  private add<T extends Family>(f: T): T {
    if (!NAME.test(f.name)) throw new Error(`bad metric name ${f.name}`);
    if (this.families.has(f.name)) throw new Error(`metric ${f.name} already registered`);
    this.families.set(f.name, f);
    return f;
  }
  counter(name: string, help: string): Counter { return this.add(new Counter(name, help)); }
  gauge(name: string, help: string): Gauge { return this.add(new Gauge(name, help)); }
  histogram(name: string, help: string, buckets: readonly number[] = LATENCY_BUCKETS): Histogram { return this.add(new Histogram(name, help, buckets)); }
  /** Runs before each scrape to refresh gauges from live state. A collector that throws is skipped, never fails the scrape. */
  collect(fn: () => void | Promise<void>): void { this.collectors.push(fn); }

  async render(): Promise<string> {
    for (const c of this.collectors) {
      try {
        await c();
      } catch {
        /* the gauges it feeds keep their last value */
      }
    }
    const out: string[] = [];
    for (const f of this.families.values()) {
      const lines = f.lines();
      if (!lines.length) continue;
      out.push(`# HELP ${f.name} ${f.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${f.name} ${f.type}`, ...lines);
    }
    return out.join("\n") + "\n";
  }
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// ---- access ---------------------------------------------------------------------------------------------------------

function ipv4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** Loopback, RFC 1918, link-local and unique-local addresses: a peer on the deployment's own networks. */
export function isInternalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1]!;
  const v4 = ipv4(a);
  if (v4) {
    const [p, q] = v4 as [number, number];
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  return a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** Comparison of two strings with no early exit on the first differing character. */
export function tokenEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export interface MetricsAccessInput {
  /** The socket peer (never X-Forwarded-For). */
  remoteAddress: string | undefined;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Accepted bearer tokens (the metrics token, plus any service token the caller already trusts). Empty ones are ignored. */
  tokens: readonly (string | null | undefined)[];
}

/**
 * A scrape is allowed from a peer on the internal network that did not come through a proxy (the ingress always adds forwarding headers,
 * so the public site can never serve metrics even if a route leaks), or from anyone presenting a valid bearer token.
 */
export function metricsAllowed(i: MetricsAccessInput): boolean {
  const h = (n: string): string | undefined => {
    const v = i.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const m = /^Bearer (.+)$/.exec(h("authorization") ?? "");
  if (m && i.tokens.some((t) => !!t && tokenEquals(m[1]!, t))) return true;
  const proxied = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"].some((n) => h(n) !== undefined);
  return !proxied && isInternalAddress(i.remoteAddress);
}
