#!/usr/bin/env node
// The operator's part of a release's notes: what an upgrade does to the database and what a person must do first.
// GitHub's generated notes (the merged pull requests) go above this; this part cannot be generated from titles.
//
//   release-notes.mjs --manifest release.json --previous-ref v1.2.0 [--tag v1.3.0] > notes.md
// --previous-ref may be empty (the first release): every migration is then new.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIR, CONTRACT_MARK, classify } from "../ci/migration-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export function notes({ manifest, newMigrations, previousLatest, requires, tag }) {
  const out = [];
  out.push(`## Upgrading${tag ? ` to ${tag}` : ""}`, "");
  const m = manifest.migrations;
  if (!newMigrations.length) out.push("No database migrations. Rolling back is `GANTRY_VERSION` back and `up -d`; the pipeline does this by itself if the health gate fails.", "");
  else {
    out.push(`${newMigrations.length} new migration(s), schema ${previousLatest} to ${m.latest}. A backup set is taken before they run.`, "");
    for (const n of newMigrations) out.push(`- \`${n.name}\`${n.contract ? " **contract (drops or reshapes something)**" : " (expand: adds only)"}`);
    out.push("");
    if (newMigrations.some((n) => n.contract)) out.push("**This release cannot be rolled back automatically past its contract migration.** If it is unhealthy the pipeline leaves it up, pages a person and names the backup set.", "");
    else out.push("Every migration is an expand: the previous release still runs on the new schema, so a failed health gate rolls back by itself.", "");
  }
  const steps = requires.filter((r) => m.latest >= r.fromMigration && previousLatest < r.fromMigration);
  if (steps.length) {
    out.push("### A person must do this on the host before the production deploy", "");
    for (const r of steps) out.push(`- **${r.id}**: ${r.text}`);
    out.push("");
  }
  out.push("### Images (verify with `deploy/verify-images.sh`)", "", "| image | digest |", "| --- | --- |");
  for (const [n, i] of Object.entries(manifest.images)) out.push(`| gantry-${n} | \`${i.digest}\` |`);
  return out.join("\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1] ?? ""]] : acc), []));
  const manifest = JSON.parse(readFileSync(a.manifest, "utf8"));
  const git = (...x) => execFileSync("git", ["-C", root, ...x], { encoding: "utf8" });
  const prev = a["previous-ref"] || "";
  const before = prev ? git("ls-tree", "--name-only", `${prev}:${DIR}/`).split("\n").filter((n) => n.endsWith(".sql")) : [];
  const now = git("ls-tree", "--name-only", `${manifest.sha}:${DIR}/`).split("\n").filter((n) => n.endsWith(".sql"));
  const fresh = now.filter((n) => !before.includes(n));
  const newMigrations = fresh.map((name) => { const sql = git("show", `${manifest.sha}:${DIR}/${name}`); return { name, contract: CONTRACT_MARK.test(sql) && classify(sql).destructive }; });
  const previousLatest = before.length ? Number(before.at(-1).slice(0, 4)) : 0;
  const requires = JSON.parse(readFileSync(join(here, "preconditions.json"), "utf8")).requires;
  process.stdout.write(notes({ manifest, newMigrations, previousLatest, requires, tag: a.tag }));
}
