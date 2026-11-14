/**
 * Secret scanning for stored content (spec 5.3, 7.4: secrets never appear in traces or artefacts).
 * Content is scanned before it reaches object storage; matches are replaced by [REDACTED:<kind>] so the stored text is safe.
 * Two detectors: patterns for common key formats, and exact match against the vendor keys the edge itself holds.
 */
export interface Finding {
  kind: string;
  count: number;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe-key", re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}/g },
  { kind: "gantry-run-token", re: /\bgrt\.[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{20,128}/g },
  { kind: "bearer-token", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "credential-url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{4,}@[^\s/]+/gi },
];

export interface ScanResult {
  text: string;
  findings: Finding[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Known secret values (vendor keys). Values shorter than 8 characters are ignored: they would redact ordinary words. */
export function scanText(text: string, known: Iterable<string> = []): ScanResult {
  const counts = new Map<string, number>();
  let out = text;
  for (const k of known) {
    if (k.length < 8 || !out.includes(k)) continue;
    const re = new RegExp(escapeRe(k), "g");
    out = out.replace(re, () => {
      counts.set("known-key", (counts.get("known-key") ?? 0) + 1);
      return "[REDACTED:known-key]";
    });
  }
  for (const p of PATTERNS) {
    out = out.replace(p.re, () => {
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
      return `[REDACTED:${p.kind}]`;
    });
  }
  return { text: out, findings: [...counts].map(([kind, count]) => ({ kind, count })) };
}

/** Redacts every string inside a JSON value (keys are kept). */
export function scanJson(v: unknown, known: Iterable<string> = []): { value: unknown; findings: Finding[] } {
  const total = new Map<string, number>();
  const knownArr = [...known];
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      const r = scanText(x, knownArr);
      for (const f of r.findings) total.set(f.kind, (total.get(f.kind) ?? 0) + f.count);
      return r.text;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  const value = walk(v);
  return { value, findings: [...total].map(([kind, count]) => ({ kind, count })) };
}
