/** Secrets are removed from text that is about to be written to GitHub (a pull request description is public to the repository's readers). The shapes are the ones the edge redacts from agent documents. */
const SHAPES: RegExp[] = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]{4,}@/gi,
];

export function redactSecrets(text: string): { text: string; redacted: number } {
  let n = 0;
  let out = text;
  for (const re of SHAPES) out = out.replace(re, (m, g1) => { n++; return typeof g1 === "string" && g1.endsWith("://") ? `${g1}[redacted]@` : "[redacted]"; });
  return { text: out, redacted: n };
}
