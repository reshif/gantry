#!/usr/bin/env node
// Migration safety (expand/contract), the CI side of deploy/release/gantry-release.sh's rollback rule.
//
// Migrations only go forward and run before the new api and worker start, while the OLD api and worker may still be serving. So a
// migration is one of two kinds:
//   expand    adds things the old code ignores: a table, a nullable or defaulted column, an index, a widening constraint change.
//   contract  removes or reshapes something the old code may still use: drop or rename a table or column, change a column's type,
//             SET NOT NULL, drop a constraint, truncate, delete rows. It declares itself with a line `-- gantry:contract <reason>`.
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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "packages/db/migrations";
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
export const CONTRACT_MARK = /^--\s*gantry:contract\b/m;

/** SQL with comments and string literals blanked, so a word inside a comment or a string is not a statement. */
export function code(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

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
const ADDITIVE = /\b(create\s+(unique\s+)?(table|index|type|function|view|extension|trigger|policy|sequence)|alter\s+table\b[^;]*\badd\s+(column|constraint)|insert\s+into)\b/i;

/** What a migration file's SQL does, in the terms of the rules above. */
export function classify(sql) {
  const body = code(sql);
  const declared = CONTRACT_MARK.test(sql);
  const reasons = DESTRUCTIVE.filter(([re]) => re.test(body)).map(([, why]) => why);
  // A trigger that forbids TRUNCATE (create trigger ... before truncate) is not a truncate.
  const additive = ADDITIVE.test(body);
  return { declared, reasons, additive, destructive: reasons.length > 0 };
}

/** Violations for the migrations `after` (name -> sql) against `before` (name -> sql, the base). */
export function check(before, after) {
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
  const fresh = names.filter((n) => !(n in before));
  for (const n of fresh) {
    const c = classify(after[n]);
    if (c.destructive && !c.declared) problems.push(`${n}: ${c.reasons.join("; ")}. A migration like this is a contract migration: add the line "-- gantry:contract <why it is safe now>" and ship it one release after the code stopped using what it removes. Otherwise make it an expand.`);
    if (c.declared && !c.destructive) problems.push(`${n}: declared "-- gantry:contract" but removes nothing; delete the line (a contract mark stops automatic rollback past this release)`);
    if (c.declared && c.additive) problems.push(`${n}: a contract migration must not also create or add things; split it into two files (the expand one ships first)`);
  }
  return { problems, fresh, contractFresh: fresh.filter((n) => CONTRACT_MARK.test(after[n])) };
}

/** {latest, lastContract, files} of a set of migrations: lastContract is the highest number carrying the mark. */
export function info(files) {
  const names = Object.keys(files).filter((n) => NAME.test(n)).sort();
  const num = (n) => Number(NAME.exec(n)[1]);
  const contracts = names.filter((n) => CONTRACT_MARK.test(files[n])).map(num);
  return { latest: names.length ? num(names.at(-1)) : 0, lastContract: contracts.length ? Math.max(...contracts) : 0, files: names.length };
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
  const { problems, fresh, contractFresh } = check(readBase(root, arg), after);
  console.log(`migrations: ${Object.keys(after).length} files, ${fresh.length} new against ${arg}`);
  for (const n of contractFresh) console.log(`::warning title=Contract migration::${n} is a contract migration: this release cannot be rolled back automatically past it, and it must ship one release after the code stopped using what it removes.`);
  for (const p of problems) console.log(`::error title=Migration safety::${p}`);
  if (problems.length) process.exit(1);
  console.log("migration safety: ok");
}
