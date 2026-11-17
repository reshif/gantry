#!/usr/bin/env node
// Ratchet for the architecture lint warnings. `node scripts/lint-ratchet.mjs` (CI) fails when any rule's count for any
// view is above apps/web/lint-baseline.json, or below it (the baseline must shrink in the same PR that fixes the code).
//   --update  rewrite the baseline; refuses to raise any count (the baseline only shrinks)
//   --init    write a first baseline when none exists
import { existsSync, writeFileSync } from "node:fs";
import { BASELINE_FILE, collectCounts, compare, readBaseline, sortedRules } from "./lib/frontend-counts.mjs";

const arg = process.argv[2];
const counts = collectCounts();
const write = (rules) =>
  writeFileSync(BASELINE_FILE, JSON.stringify({ note: "Per-rule, per-view lint warning counts. May only shrink: node scripts/lint-ratchet.mjs --update", rules: sortedRules(rules) }, null, 2) + "\n");

if (arg === "--init") {
  if (existsSync(BASELINE_FILE)) {
    console.error("baseline already exists; use --update");
    process.exit(1);
  }
  write(counts);
  console.log("baseline written");
  process.exit(0);
}

const base = readBaseline();
if (!base) {
  console.error("apps/web/lint-baseline.json is missing; run: node scripts/lint-ratchet.mjs --init");
  process.exit(1);
}
const { grown, shrunk } = compare(counts, base);
const fmt = (d) => `  ${d.rule} in ${d.group}: baseline ${d.was}, now ${d.now}`;

if (arg === "--update") {
  if (grown.length) {
    console.error("The baseline may only shrink. These counts grew; fix the code:\n" + grown.map(fmt).join("\n"));
    process.exit(1);
  }
  write(counts);
  console.log(`baseline updated (${shrunk.length} count(s) lowered)`);
  process.exit(0);
}

if (grown.length) {
  console.error("Lint ratchet: new violations of the frontend architecture rules (fix them, do not raise the baseline):\n" + grown.map(fmt).join("\n"));
  process.exit(1);
}
if (shrunk.length) {
  console.error("Lint ratchet: fewer violations than the baseline. Lock in the gain: node scripts/lint-ratchet.mjs --update\n" + shrunk.map(fmt).join("\n"));
  process.exit(1);
}
console.log("Lint ratchet: ok (no rule grew or shrank against apps/web/lint-baseline.json)");
