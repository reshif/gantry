#!/usr/bin/env node
// Migration safety (expand/contract), the CI side of deploy/release/gantry-release.sh's rollback rule.
//
// Migrations only go forward and run before the new api and worker start, while the OLD api and worker may still be serving. So a
// migration is one of two kinds:
//   expand    adds things the old code ignores: a table, a nullable or defaulted column, an index, a widening constraint change.
//   contract  removes or reshapes something the old code may still use: drop or rename a table or column, change a column's type,
//             SET NOT NULL, a NOT NULL column without default, a new CHECK / UNIQUE / FOREIGN KEY, drop a constraint, truncate, delete rows. It declares itself with a line `-- gantry:contract after <sha>`: <sha> is the commit, already on main, from which no code uses what
//             the migration removes or tightens. The host refuses the migration unless the RUNNING release contains <sha>.
// `after <sha>` is a REVIEWER-CHECKED ASSERTION: CI checks that the commit exists and is on the base, and the host checks that the running release
// contains it, but only a person can check that the code at that commit really stopped using what is dropped. CODEOWNERS requires a review.
// Rules (a new migration is one the base does not have):
//   1. A migration that does something a contract does, but does not say `-- gantry:contract`, fails: say it or make it an expand.
//   2. A contract migration lives alone in its file: it does not also create or add things (split it, so a rollback target exists).
//   3. An applied migration is never edited or removed (the runner refuses too; this fails the pull request sooner).
//   4. File names are NNNN_snake_case.sql with the next number, no gaps, no duplicates.
// A contract migration also means "no automatic rollback past it": the release manifest records the highest contract level
// (`lastContract`) and the host refuses to roll back to an image older than it (deploy/release/gantry-release.sh).
//
//   node deploy/ci/migration-safety.mjs BASE_REV      compare this tree with BASE_REV (a git revision); exit 1 on a violation
//   node deploy/ci/migration-safety.mjs --info        print {"latest":N,"lastContract":M,"files":K} for this tree (json)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "packages/db/migrations";
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
export const CONTRACT_MARK = /^--\s*gantry:contract\b/m;
/** `-- gantry:contract after <sha>`: the commit (already on main) from which no code uses what this migration removes. */
export const CONTRACT_AFTER = /^--\s*gantry:contract\s+after\s+([0-9a-f]{7,40})\b/m;

/**
 * SQL with comments and string literals blanked, so a word inside a comment or a string is not a statement. A dollar-quoted body
 * is blanked when it belongs to a function or procedure (it runs later, not now) and kept when it is a DO block (it runs now).
 */
export function code(sql) {
  let t = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  t = t.replace(/\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/g, (m, _tag, body, off) => {
    const before = t.slice(0, off);
    const stmt = before.slice(before.lastIndexOf(";") + 1);
    return /\bcreate\s+(or\s+replace\s+)?(function|procedure)\b/i.test(stmt) ? " " : ` ; ${body} ; `;
  });
  return t.replace(/'(?:[^']|'')*'/g, "''");
}

// What removes or reshapes something the old code may still use, or tightens what it may still write.
const DESTRUCTIVE = [
  [/\bdrop\s+(table|column|schema|type|view|materialized\s+view|function|trigger|constraint|policy|rule|sequence|extension)\b/i, "drops something"],
  [/\bdrop\s+index\b/i, "drops an index (the old code may rely on its uniqueness or speed)"],
  [/\balter\s+table\b[^;]*\brename\b/i, "renames a table or column"],
  [/\balter\s+type\b[^;]*\brename\b/i, "renames a type or value"],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\b(set\s+data\s+)?type\b/i, "changes a column's type"],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\bset\s+not\s+null\b/i, "sets NOT NULL (the old code may still write nulls)"],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\bdrop\s+default\b/i, "drops a default (the old code may rely on it)"],
  [/\btruncate\b(?!\s+on\b)/i, "truncates a table"],
  [/\bdelete\s+from\b/i, "deletes rows"],
  [/\brevoke\b/i, "revokes a privilege (the old code may need it)"],
];
const ADDITIVE = /\b(create\s+(table|index|type|function|procedure|view|extension|trigger|policy|sequence)|alter\s+table\b[^;]*\badd\s+(column\b|if\b|\w+\s)|insert\s+into)\b/i;

/** Top-level comma split (not inside parentheses). */
function clauses(s) {
  const out = []; let d = 0, cur = "";
  for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; }
  return [...out, cur];
}
const tableOf = (stmt, re) => (re.exec(stmt) ?? [])[1]?.toLowerCase();

/** Tightening a statement can do to a table that already exists: a NOT NULL column with no default, CHECK, UNIQUE, PRIMARY KEY, FK. */
function tightening(stmt, created) {
  const why = [];
  const alter = /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?("?[\w.]+"?)/i.exec(stmt);
  if (alter && !created.has(alter[1].toLowerCase())) {
    for (const c of clauses(stmt.slice(alter.index + alter[0].length))) {
      if (/\badd\s+(column\s+)?(if\s+not\s+exists\s+)?\S+\s/i.test(c) && !/^\s*add\s+constraint\b/i.test(c) && /\bnot\s+null\b/i.test(c) && !/\bdefault\b|\bgenerated\b/i.test(c)) why.push("adds a NOT NULL column with no default (the old code does not write it)");
      if (/\badd\s+(constraint\s+\S+\s+)?(check|unique|primary\s+key|foreign\s+key|exclude)\b/i.test(c) && !/\bnot\s+valid\b/i.test(c)) why.push("adds a CHECK, UNIQUE, PRIMARY KEY or FOREIGN KEY constraint (the old code may violate it)");
      if (!/^\s*add\s+constraint\b/i.test(c) && /\badd\s+(column\s+)?(if\s+not\s+exists\s+)?\S+\s[^,]*\b(references|unique|check)\b/i.test(c)) why.push("adds a column with an inline CHECK, UNIQUE or REFERENCES");
    }
  }
  const idx = /\bcreate\s+unique\s+index\b[^;]*?\bon\s+(?:only\s+)?("?[\w.]+"?)/i.exec(stmt);
  if (idx && !created.has(idx[1].toLowerCase())) why.push("creates a UNIQUE index (the old code may write duplicates)");
  return why;
}

/** What a migration file's SQL does, in the terms of the rules above. Statement by statement. */
export function classify(sql) {
  const body = code(sql);
  const declared = CONTRACT_MARK.test(sql);
  const stmts = body.split(";").map((x) => x.trim()).filter(Boolean);
  const created = new Set(stmts.map((x) => tableOf(x, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?)/i)).filter(Boolean));
  const reasons = []; let additive = false;
  for (const st of stmts) {
    const r = [...DESTRUCTIVE.filter(([re]) => re.test(st)).map(([, why]) => why), ...tightening(st, created)];
    if (r.length) reasons.push(...r);
    else if (ADDITIVE.test(st)) additive = true;
  }
  const uniq = [...new Set(reasons)];
  return { declared, reasons: uniq, additive, destructive: uniq.length > 0 };
}

/**
 * Violations for the migrations `after` (name -> sql) against `before` (name -> sql, the base). `released` (name -> sha256) lists migrations
 * already applied on deployed stacks before this policy existed (deploy/ci/migrations-released.txt): they are not judged as new, and an edit
 * to one is refused exactly like an edit to a migration in the base (the runner checksums applied migrations).
 */
export function check(before, after, released = {}) {
  const problems = [];
  const names = Object.keys(after).sort();
  const nums = [];
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) problems.push(`${n}: the name must be NNNN_snake_case.sql`);
    else nums.push(Number(m[1]));
  }
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1]) problems.push(`${names[i]}: duplicate migration number ${nums[i]}`);
    else if (nums[i] !== nums[i - 1] + 1) problems.push(`${names[i]}: migration numbers have a gap (${nums[i - 1]} then ${nums[i]}); renumber after a rebase`);
  }
  for (const [n, sql] of Object.entries(before)) {
    if (!(n in after)) problems.push(`${n}: an applied migration was removed`);
    else if (after[n] !== sql) problems.push(`${n}: an applied migration was edited (write a new migration instead)`);
  }
  for (const [n, sum] of Object.entries(released)) {
    if (n in before) continue;
    if (!(n in after)) problems.push(`${n}: a released migration was removed`);
    else if (sha256(after[n]) !== sum) problems.push(`${n}: a released migration was edited (write a new migration instead; the runner checksums applied migrations)`);
  }
  const fresh = names.filter((n) => !(n in before) && !(n in released));
  for (const n of fresh) {
    const c = classify(after[n]);
    if (c.destructive && !c.declared) problems.push(`${n}: ${c.reasons.join("; ")}. A migration like this is a contract migration: add the line "-- gantry:contract after <sha>" (the commit on main from which no code uses what it removes or tightens) and ship it one release after that commit. Otherwise make it an expand. NOTE: "after <sha>" is an assertion a reviewer must check (this tool cannot tell whether the code really stopped using it); the review of packages/db/migrations/** is required (CODEOWNERS).`);
    if (c.declared && !CONTRACT_AFTER.test(after[n])) problems.push(`${n}: "-- gantry:contract" must name the commit: "-- gantry:contract after <sha>" (the host refuses the migration unless the running release contains that commit)`);
    if (c.declared && !c.destructive) problems.push(`${n}: declared "-- gantry:contract" but removes nothing; delete the line (a contract mark stops automatic rollback past this release)`);
    if (c.declared && c.additive) problems.push(`${n}: a contract migration must not also create or add things; split it into two files (the expand one ships first)`);
  }
  return { problems, fresh, contractFresh: fresh.filter((n) => CONTRACT_MARK.test(after[n])) };
}

/** {latest, lastContract, files, contracts:[{n, after}]} of a set of migrations; `after` is the sha as written in the mark ("" when missing). */
export function info(files) {
  const names = Object.keys(files).filter((n) => NAME.test(n)).sort();
  const num = (n) => Number(NAME.exec(n)[1]);
  const contracts = names.filter((n) => CONTRACT_MARK.test(files[n])).map((n) => ({ n: num(n), after: CONTRACT_AFTER.exec(files[n])?.[1] ?? "" }));
  return { latest: names.length ? num(names.at(-1)) : 0, lastContract: contracts.length ? Math.max(...contracts.map((c) => c.n)) : 0, files: names.length, contracts };
}

/** A new contract migration's `after` commit must exist and already be on the base (it is merged, so a release can contain it). */
export function ancestryProblems(root, base, files, fresh) {
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const out = [];
  for (const n of fresh) {
    const m = CONTRACT_AFTER.exec(files[n]);
    if (!m) continue;
    if (git("cat-file", "-e", `${m[1]}^{commit}`).status !== 0) out.push(`${n}: the commit ${m[1]} named in "gantry:contract after" does not exist in this repository`);
    else if (git("merge-base", "--is-ancestor", m[1], base).status !== 0) out.push(`${n}: ${m[1]} is not on the base branch yet; the commit that stops using what this drops must be merged and released first`);
  }
  return out;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** deploy/ci/migrations-released.txt: "<name> <sha256>" per line, migrations applied on deployed stacks before the expand/contract policy. */
function readReleased(root) {
  const p = join(root, "deploy/ci/migrations-released.txt");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [n, sum] = t.split(/\s+/);
    if (n && sum) out[n] = sum;
  }
  return out;
}
const read = (dir) => Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith(".sql")).map((n) => [n, readFileSync(join(dir, n), "utf8")]));
function readBase(root, rev) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  try { git("cat-file", "-e", `${rev}:${DIR}`); } catch { return {}; }
  const out = {};
  for (const n of git("ls-tree", "--name-only", `${rev}:${DIR}/`).split("\n").filter((x) => x.endsWith(".sql"))) out[n] = git("show", `${rev}:${DIR}/${n}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const arg = process.argv[2];
  if (!arg) { console.error("usage: migration-safety.mjs BASE_REV | --info"); process.exit(2); }
  const after = read(join(root, DIR));
  if (arg === "--info") { console.log(JSON.stringify(info(after))); process.exit(0); }
  const { problems, fresh, contractFresh } = check(readBase(root, arg), after, readReleased(root));
  problems.push(...ancestryProblems(root, arg, after, fresh));
  console.log(`migrations: ${Object.keys(after).length} files, ${fresh.length} new against ${arg}`);
  for (const n of contractFresh) console.log(`::warning title=Contract migration::${n} is a contract migration: this release cannot be rolled back automatically past it, and it must ship one release after the code stopped using what it removes.`);
  for (const p of problems) console.log(`::error title=Migration safety::${p}`);
  if (problems.length) process.exit(1);
  console.log("migration safety: ok");
}
