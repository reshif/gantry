/** IPv4 CIDR helpers (the server's ipAllowed() is the enforcement; these only validate input and explain the lock-out guard). */
export function ipNum(ip: string): number | null {
  const p = String(ip).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const x = Number(part);
    if (!/^\d{1,3}$/.test(part) || x > 255) return null;
    n = n * 256 + x;
  }
  return n;
}
export function parseCidr(c: string): { base: number; bits: number; text: string } | null {
  const m = String(c).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const base = ipNum(m[1]!);
  const bits = m[2] == null ? 32 : Number(m[2]);
  if (base == null || bits > 32) return null;
  return { base, bits, text: `${m[1]}/${bits}` };
}
export function inCidr(ip: string, c: string): boolean {
  const p = parseCidr(c);
  const n = ipNum(ip);
  if (!p || n == null) return false;
  if (p.bits === 0) return true;
  const size = 2 ** (32 - p.bits);
  return Math.floor(n / size) === Math.floor(p.base / size);
}
