#!/usr/bin/env node
/** Fails (exit 1) on undefined CSS variables, failing token-pair contrast, or drifting dark blocks. Run: npm run check:tokens -w apps/web */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runChecks } from "./tokens-lib.mjs";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const r = runChecks(srcDir);
for (const u of r.undefinedVars) console.error(`undefined variable ${u.name} in ${u.file}`);
for (const d of r.darkDiff) console.error(`dark blocks differ on ${d}`);
for (const c of r.contrast) console.error(`${c.theme}: ${c.fg} on ${c.bg} (${c.why}) ${c.unresolved ? "does not resolve to a hex colour" : `${c.ratio} < ${c.min}`}`);
const n = r.undefinedVars.length + r.darkDiff.length + r.contrast.length;
if (n) {
  console.error(`check-tokens: ${n} problem(s)`);
  process.exit(1);
}
console.log("check-tokens: ok");
