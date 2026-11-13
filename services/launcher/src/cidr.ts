/** Minimal IPv4 CIDR arithmetic for allocating small run subnets from one dedicated pool. */

export interface Cidr {
  /** Network address as an unsigned 32-bit integer. */
  base: number;
  prefix: number;
}

const OCTET = /^(0|[1-9]\d{0,2})$/;

/** `align: true` rounds a host address down to its network (for subnets reported by other tools); default refuses unaligned input. */
export function parseCidr(text: string, opts: { align?: boolean } = {}): Cidr | undefined {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(text);
  if (!m) return undefined;
  const parts = (m[1] as string).split(".");
  let addr = 0;
  for (const p of parts) {
    if (!OCTET.test(p) || Number(p) > 255) return undefined;
    addr = addr * 256 + Number(p);
  }
  const prefix = Number(m[2]);
  if (prefix > 32) return undefined;
  const size = 2 ** (32 - prefix);
  // Network address must be aligned to its prefix.
  if (addr % size !== 0) {
    if (!opts.align) return undefined;
    return { base: addr - (addr % size), prefix };
  }
  return { base: addr, prefix };
}

export function formatCidr(c: Cidr): string {
  const a = c.base;
  return `${Math.floor(a / 2 ** 24) % 256}.${Math.floor(a / 2 ** 16) % 256}.${Math.floor(a / 256) % 256}.${a % 256}/${c.prefix}`;
}

export const cidrSize = (c: Cidr): number => 2 ** (32 - c.prefix);

export function overlaps(a: Cidr, b: Cidr): boolean {
  return a.base < b.base + cidrSize(b) && b.base < a.base + cidrSize(a);
}

/** Number of `prefix`-sized blocks in `pool`. */
export function blockCount(pool: Cidr, prefix: number): number {
  return prefix < pool.prefix ? 0 : 2 ** (prefix - pool.prefix);
}

/**
 * First `prefix`-sized block inside `pool` that overlaps none of `used`, scanning from `startIndex` and wrapping.
 * Returns undefined when the pool is exhausted.
 */
export function firstFreeBlock(pool: Cidr, prefix: number, used: readonly Cidr[], skip: ReadonlySet<string> = new Set(), startIndex = 0): Cidr | undefined {
  const n = blockCount(pool, prefix);
  const size = 2 ** (32 - prefix);
  // Only used ranges that touch the pool matter.
  const relevant = used.filter((u) => overlaps(u, pool)).sort((a, b) => a.base - b.base);
  for (let i = 0; i < n; i++) {
    const idx = (startIndex + i) % n;
    const cand: Cidr = { base: pool.base + idx * size, prefix };
    if (skip.has(formatCidr(cand))) continue;
    if (relevant.some((u) => overlaps(u, cand))) continue;
    return cand;
  }
  return undefined;
}
