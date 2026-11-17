// Shared by lint-ratchet.mjs and frontend-dod.mjs: per-rule, per-view violation counts for apps/web/src.
// Rule ids are the [tag] at the start of an architecture lint message (eslint.config.web.js), the jsx-a11y rule
// ids, and `polling-interval` (a source scan: refetchInterval / setInterval in a view).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WEB_SRC = join(ROOT, "apps", "web", "src");
export const BASELINE_FILE = join(ROOT, "apps", "web", "lint-baseline.json");

const isTest = (p) => /\.test\.[jt]sx?$/.test(p) || p.includes("/test/");

/** Group a file under a view (`views/access` for views/access.tsx and views/access/*) or its top-level directory. */
export function groupOf(file) {
  const rel = relative(WEB_SRC, file).split("\\").join("/");
  const parts = rel.split("/");
  if (parts[0] === "views" && parts.length > 1) return `views/${parts[1].replace(/\.[jt]sx?$/, "")}`;
  return parts.length > 1 ? parts[0] : rel;
}

export function ruleIdOf(m) {
  const tag = /\[([a-z][a-z-]+)\]/.exec(m.message);
  return tag ? tag[1] : m.ruleId;
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.[jt]sx?$/.test(n)) out.push(p);
  }
  return out;
}

/** Polling in a view: refetchInterval or setInterval occurrences (live data comes from the stream). */
export const pollingCount = (src) => (src.match(/\b(refetchInterval|setInterval)\b/g) ?? []).length;

/** Run eslint over apps/web/src and return its JSON results (warnings and errors). */
export function runEslint() {
  let out;
  try {
    out = execFileSync(process.execPath, [join(ROOT, "node_modules", "eslint", "bin", "eslint.js"), "apps/web/src", "--format", "json"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  } catch (e) {
    // eslint exits 1 when there are errors; the JSON is still on stdout.
    if (!e.stdout) throw e;
    out = e.stdout.toString();
  }
  return JSON.parse(out);
}

/** { rule: { group: count } }. Only the tracked rules: architecture tags and jsx-a11y; plain lint errors are not baselined. */
export function collectCounts() {
  const counts = {};
  const add = (rule, group) => {
    counts[rule] ??= {};
    counts[rule][group] = (counts[rule][group] ?? 0) + 1;
  };
  for (const f of runEslint()) {
    if (isTest(f.filePath)) continue;
    for (const m of f.messages) {
      if (m.severity !== 1) continue;
      const id = ruleIdOf(m);
      if (!id) continue;
      if (/^[a-z0-9-]+$/.test(id) || id.startsWith("jsx-a11y/")) add(id, groupOf(f.filePath));
    }
  }
  for (const file of walk(join(WEB_SRC, "views"))) {
    if (isTest(file)) continue;
    const n = pollingCount(readFileSync(file, "utf8"));
    for (let i = 0; i < n; i++) add("polling-interval", groupOf(file));
  }
  return counts;
}

export function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")).rules ?? {};
  } catch {
    return null;
  }
}

/** Compare counts to the baseline. grown: a count above the baseline (or a new one). shrunk: a count below it (the baseline is stale). */
export function compare(counts, base) {
  const grown = [];
  const shrunk = [];
  const rules = new Set([...Object.keys(counts), ...Object.keys(base)]);
  for (const r of rules) {
    const groups = new Set([...Object.keys(counts[r] ?? {}), ...Object.keys(base[r] ?? {})]);
    for (const g of groups) {
      const now = counts[r]?.[g] ?? 0;
      const was = base[r]?.[g] ?? 0;
      if (now > was) grown.push({ rule: r, group: g, was, now });
      else if (now < was) shrunk.push({ rule: r, group: g, was, now });
    }
  }
  return { grown, shrunk };
}

export function sortedRules(counts) {
  const out = {};
  for (const r of Object.keys(counts).sort()) {
    out[r] = {};
    for (const g of Object.keys(counts[r]).sort()) out[r][g] = counts[r][g];
  }
  return out;
}

/** Views present on disk: views/<name> for each top-level file or directory under views/ (tests and the barrel excluded). */
export function viewsOnDisk() {
  const names = new Set();
  for (const n of readdirSync(join(WEB_SRC, "views"))) {
    if (isTest(n) || n === "index.ts") continue;
    names.add(`views/${n.replace(/\.[jt]sx?$/, "")}`);
  }
  return [...names].sort();
}
