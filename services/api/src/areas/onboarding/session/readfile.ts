/**
 * The session agents' read-only look at any text file of the assessed repository (G-01: code gathers facts, the agent authors). Used by the onboarding and work-order
 * `read_file` tools. The repository and the commit are the ones the session is already bound to (the facts the assessment read); the model supplies only a path.
 *
 * Rails, each a refusal with a reason (never the content): the path is normalised and must be a file in the assessed tree; credential-looking paths are refused; the broker
 * refuses binary and oversized files; credential-shaped text in what is returned is redacted; each file is capped; the number of fetches is capped per turn and per session.
 * What comes back is marked as observed repository data (`mark`), never as instructions.
 */
import type { RepoFacts } from "@gantry/domain";
import { mark } from "../../console/mark.js";
import type { ReadFileFn } from "./broker.js";

export const MAX_FILE_CHARS = 4000;
export const MAX_FETCHES_PER_TURN = 40;
export const MAX_FETCHES_PER_SESSION = 200;

const sessionFetches = new Map<string, number>();
/** Test hook: forget the per-session counts. */
export const resetFileReadCounts = (): void => sessionFetches.clear();

/** A repo-relative path with no `..`, no absolute or drive prefix, no backslashes or control characters; null when it is none of that. */
export function normalisePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 300 || /[\\\0-\x1f]/.test(s) || s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:/.test(s)) return null;
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "..") return null;
    if (seg === "." || seg === "") continue;
    parts.push(seg);
  }
  return parts.length && s.slice(-1) !== "/" ? parts.join("/") : null;
}

const CREDENTIAL_PATH = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|[^/]*credentials?[^/]*|[^/]*\.tfstate(\.backup)?|[^/]*\.tfvars|kubeconfig|service[-_]?account[^/]*\.json|secrets?\.(ya?ml|json|toml|env))$/i;
export const isCredentialPath = (p: string): boolean => CREDENTIAL_PATH.test(p);

const TOKENS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, /\b[sr]k_live_[0-9a-zA-Z]{24,}/g, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const KEY_VALUE = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\w*["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi;
const REFERENCE = /^[$<{%]|^(secrets|env|vars|inputs|github|os\.|process\.|getenv|environ|none|null|true|false|changeme|example|your|xxx|\*+|\[redacted\])/i;

/** Replaces credential-shaped text with `[redacted]` and says how many places changed. */
export function redact(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  for (const re of TOKENS) out = out.replace(re, () => { n++; return "[redacted]"; });
  out = out.replace(KEY_VALUE, (m, head: string, v: string) => (REFERENCE.test(v) ? m : (n++, `${head}[redacted]`)));
  return { text: out, redactions: n };
}

export interface FileReadCtx { fileFetches?: number }

/** The agent's `read_file`: one file at the session's assessed commit. `key` identifies the session for the per-session cap. */
export async function readRepoFileFor(o: { repo: string; key: string; facts: RepoFacts; path: unknown; read: ReadFileFn | undefined; state: FileReadCtx }): Promise<Record<string, unknown>> {
  const p = normalisePath(o.path);
  if (!p) return { error: "That is not a path inside the repository. Give a repo-relative path such as src/app.py (no leading slash, no `..`)." };
  const cached = o.facts.contents[p];
  if (cached !== undefined) return { source: "observed", path: p, ...shown(cached) };
  if (isCredentialPath(p)) return { error: `${p} looks like a credential or secret file, so Gantry does not read it. Describe it from its name if that helps, or ask the person.`, refused: "credential_path" };
  if (!o.facts.truncated && !o.facts.files.includes(p)) return { error: `${p} is not a file in the repository at the assessed commit. Check the path against the file list.`, refused: "not_in_tree" };
  if (!o.read) return { error: "Reading files beyond the assessment's own is not available here.", available: Object.keys(o.facts.contents).slice(0, 60) };
  const turn = o.state.fileFetches ?? 0;
  const session = sessionFetches.get(o.key) ?? 0;
  if (turn >= MAX_FETCHES_PER_TURN) return { error: `This turn has already read ${MAX_FETCHES_PER_TURN} extra files. Work from what you have read, or continue in the next message.`, refused: "turn_cap" };
  if (session >= MAX_FETCHES_PER_SESSION) return { error: `This session has already read ${MAX_FETCHES_PER_SESSION} extra files, the most Gantry allows. Work from what you have read, or ask the person.`, refused: "session_cap" };
  o.state.fileFetches = turn + 1;
  if (sessionFetches.size > 500) sessionFetches.clear();
  sessionFetches.set(o.key, session + 1);
  const r = await o.read(o.repo, o.facts.headSha, p);
  if (!r.ok) return { error: `${p} could not be read: ${r.msg}` };
  if (r.binary || (r.content?.includes("\0") ?? false)) return { error: `${p} is a binary file; Gantry returns text only.`, refused: "binary" };
  if (r.tooLarge || r.content === null) return { error: `${p} is too large to read (${r.size} bytes). Read a smaller file, or ask the person.`, refused: "too_large" };
  return { source: "observed", path: p, size: r.size, ...shown(r.content) };
}

function shown(text: string): { content: string; truncated: boolean; redactions?: number } {
  const r = redact(text);
  return { content: mark(r.text, MAX_FILE_CHARS), truncated: r.text.length > MAX_FILE_CHARS, ...(r.redactions ? { redactions: r.redactions } : {}) };
}
