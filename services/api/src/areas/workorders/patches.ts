/**
 * Reading the code an agent changed (spec 7.3 Code): the stored patch of a commit, parsed into files and hunks for the Changes page.
 * Read-only. The patch text lives in `github_blobs` (kind 'patch', keyed by the sha256 that `patches.content_hash` holds). It is redacted
 * with the same key shapes the edge scans stored content for, capped in size with an honest `truncated` flag, and binary files carry no content.
 */
import type { Queryable } from "@gantry/db";
import { refuse } from "../../core/index.js";

/** At most this many bytes of one patch are shown, and at most this many across a whole-work-order diff. */
export const PATCH_CAP_BYTES = 400_000;
export const DIFF_CAP_BYTES = 800_000;

export type DiffLine = { kind: "add" | "del" | "ctx"; old: number | null; new: number | null; text: string; noNewline?: true };
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string; oldPath: string | null; status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean; plus: number; minus: number; hunks: DiffHunk[];
};

/** The same shapes as the edge's secrets scan (services/edge/src/secrets-scan.ts); kept in step with it. */
const SECRETS: Array<{ kind: string; re: RegExp }> = [
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

export function redactPatch(text: string): { text: string; redactions: number } {
  let n = 0;
  let out = text;
  for (const p of SECRETS) out = out.replace(p.re, () => { n++; return `[REDACTED:${p.kind}]`; });
  return { text: out, redactions: n };
}

const unq = (s: string): string => s.replace(/^"|"$/g, "").replace(/^[ab]\//, "");

/** Parses git's unified diff output. Tolerant: unknown header lines are skipped, a truncated tail is kept as far as it goes. */
export function parseDiff(text: string): DiffFile[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let o = 0, nn = 0, ro = 0, rn = 0;
  for (const raw of lines) {
    const line = raw.endsWith("\r") && !h ? raw.slice(0, -1) : raw;
    if (h && (ro > 0 || rn > 0)) {
      const c = line[0];
      if (c === "+") { h.lines.push({ kind: "add", old: null, new: nn++, text: line.slice(1) }); rn--; f!.plus++; continue; }
      if (c === "-") { h.lines.push({ kind: "del", old: o++, new: null, text: line.slice(1) }); ro--; f!.minus++; continue; }
      if (c === " " || line === "") { h.lines.push({ kind: "ctx", old: o++, new: nn++, text: line.slice(1) }); ro--; rn--; continue; }
    }
    if (h && line.startsWith("\\")) { const last = h.lines[h.lines.length - 1]; if (last) last.noNewline = true; continue; }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      const p = m ? unq(m[2]!) : line.slice(11);
      f = { path: p, oldPath: null, status: "modified", binary: false, plus: 0, minus: 0, hunks: [] };
      files.push(f); h = null; ro = rn = 0;
      continue;
    }
    if (!f) continue;
    if (!h && line.startsWith("new file mode")) f.status = "added";
    else if (!h && line.startsWith("deleted file mode")) f.status = "deleted";
    else if (!h && line.startsWith("rename from ")) { f.oldPath = unq(line.slice(12)); f.status = "renamed"; }
    else if (!h && line.startsWith("rename to ")) f.path = unq(line.slice(10));
    else if (!h && (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) f.binary = true;
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      h = { oldStart: +m[1]!, oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3]!, newLines: m[4] === undefined ? 1 : +m[4], header: m[5] ?? "", lines: [] };
      o = h.oldStart; nn = h.newStart; ro = h.oldLines; rn = h.newLines;
      f.hunks.push(h);
    }
  }
  return files;
}

/** Cuts text to at most `cap` bytes on a line boundary. */
export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= cap) return { text, truncated: false };
  const cut = Buffer.from(text).subarray(0, cap).toString("utf8").replace(/�+$/, "");
  const nl = cut.lastIndexOf("\n");
  return { text: nl >= 0 ? cut.slice(0, nl + 1) : "", truncated: true };
}

const strip = (f: DiffFile): DiffFile => (f.binary ? { ...f, hunks: [] } : f);
const wantPath = (f: DiffFile, path: string | undefined): boolean => !path || f.path === path || f.oldPath === path;

type Row = { id: string; commit_id: string | null; pr_id: string | null; content_hash: string; size_bytes: string; sha: string | null };

async function blobOf(db: Queryable, orgId: string, hash: string): Promise<string | null> {
  const r = (await db.query<{ content: Buffer }>(`select content from github_blobs where org_id = $1 and hash = $2 and kind = 'patch'`, [orgId, hash])).rows[0];
  return r ? r.content.toString("utf8") : null;
}

/** One stored patch (a commit's), parsed. 404 with the reason when the work order has no such patch or its stored text is gone. */
export async function readPatch(db: Queryable, orgId: string, woId: string, patchId: string, path?: string) {
  const p = (await db.query<Row>(
    `select p.id, p.commit_id, p.pr_id, p.content_hash, p.size_bytes::text, c.sha from patches p left join commits c on c.org_id = p.org_id and c.id = p.commit_id where p.org_id = $1 and p.wo_id = $2 and p.id = $3`, [orgId, woId, patchId])).rows[0];
  if (!p) throw refuse("not_found", "This work order has no such patch.");
  const raw = await blobOf(db, orgId, p.content_hash);
  if (raw === null) throw refuse("not_found", "The stored text of this patch is no longer available (its object is missing), so the diff cannot be shown. The file list on the Changes page is still correct.");
  const red = redactPatch(raw);
  const cap = capText(red.text, PATCH_CAP_BYTES);
  const all = parseDiff(cap.text);
  return {
    id: p.id, commit: p.sha, bytes: Number(p.size_bytes), truncated: cap.truncated, redactions: red.redactions,
    fileCount: all.length, files: all.filter((f) => wantPath(f, path)).map(strip),
  };
}

/**
 * One entry per path across all of the work order's commits, oldest first. A git patch is per commit and the base file is not stored, so the net
 * change of a path touched by several commits cannot be recomputed here: such a path lists each commit's hunks (`commits`) and `plus` / `minus`
 * are the sums (`approximate`). A path touched once is exact.
 */
export async function readDiff(db: Queryable, orgId: string, woId: string, path?: string) {
  const rows = (await db.query<Row>(
    `select p.id, p.commit_id, p.pr_id, p.content_hash, p.size_bytes::text, c.sha from patches p left join commits c on c.org_id = p.org_id and c.id = p.commit_id
     where p.org_id = $1 and p.wo_id = $2 order by c.committed_at nulls last, p.created_at, p.id`, [orgId, woId])).rows;
  type Agg = { path: string; status: DiffFile["status"]; oldPath: string | null; binary: boolean; plus: number; minus: number; approximate: boolean; commits: Array<{ commit: string | null; patch: string; plus: number; minus: number; status: DiffFile["status"]; hunks: DiffHunk[] }> };
  const by = new Map<string, Agg>();
  let budget = DIFF_CAP_BYTES, truncated = false, redactions = 0;
  const missing: string[] = [];
  for (const r of rows) {
    if (budget <= 0) { truncated = true; break; }
    const raw = await blobOf(db, orgId, r.content_hash);
    if (raw === null) { missing.push(r.id); continue; }
    const red = redactPatch(raw);
    redactions += red.redactions;
    const cap = capText(red.text, budget);
    if (cap.truncated) truncated = true;
    budget -= Buffer.byteLength(cap.text);
    for (const f of parseDiff(cap.text)) {
      if (!wantPath(f, path)) continue;
      const g = strip(f);
      let a = by.get(g.path);
      if (!a) { a = { path: g.path, status: g.status, oldPath: g.oldPath, binary: g.binary, plus: 0, minus: 0, approximate: false, commits: [] }; by.set(g.path, a); }
      else { a.approximate = true; if (g.status === "deleted") a.status = "deleted"; else if (a.status === "deleted") a.status = "modified"; a.binary ||= g.binary; }
      a.plus += g.plus; a.minus += g.minus;
      a.commits.push({ commit: r.sha, patch: r.id, plus: g.plus, minus: g.minus, status: g.status, hunks: g.hunks });
    }
  }
  return { truncated, redactions, missingPatches: missing, files: [...by.values()].sort((x, y) => x.path.localeCompare(y.path)) };
}
