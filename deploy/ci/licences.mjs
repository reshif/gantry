#!/usr/bin/env node
// Licence check (CI): every package that ships in an image (npm production dependencies of the root workspaces and of the
// runner wrapper) must carry a licence on the allow-list. A package with a missing or different licence fails the job;
// add it to ALLOW_PACKAGES only after someone has read its terms.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const ALLOW = new Set(["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "BlueOak-1.0.0", "Python-2.0", "CC0-1.0", "CC-BY-4.0", "Unlicense", "Zlib"]);
// Reviewed exceptions: name -> why it is acceptable.
const ALLOW_PACKAGES = {};

function walk(dir) {
  let out;
  try {
    out = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // npm ls exits non-zero for problems such as an extraneous package; the tree it printed is still complete.
    if (!e.stdout) throw e;
    out = e.stdout;
  }
  const seen = new Map();
  const visit = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (!d.path || seen.has(d.path)) continue;
      // Our own workspaces are linked into node_modules; only third-party packages are checked.
      if (realpathSync(d.path).includes("/node_modules/")) {
        let lic = "";
        try {
          const pkg = JSON.parse(readFileSync(join(d.path, "package.json"), "utf8"));
          lic = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : "");
        } catch { /* unreadable */ }
        seen.set(d.path, { name, version: d.version, lic });
      }
      visit(d.dependencies);
    }
  };
  visit(JSON.parse(out).dependencies);
  return [...seen.values()];
}

const ok = (lic) => {
  const ids = lic.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/i).map((s) => s.trim()).filter(Boolean);
  // "A OR B": one allowed licence is enough. "A AND B": every part must be allowed.
  return /\sAND\s/i.test(lic) ? ids.every((i) => ALLOW.has(i)) : ids.some((i) => ALLOW.has(i));
};

let bad = 0;
let total = 0;
for (const dir of [".", "runner/wrapper"]) {
  for (const p of walk(dir)) {
    total++;
    if (ok(p.lic) || ALLOW_PACKAGES[p.name]) continue;
    console.error(`not allowed: ${p.name}@${p.version} (${p.lic || "no licence"}) in ${dir}`);
    bad++;
  }
}
if (bad) { console.error(`${bad} of ${total} shipped packages need a licence review`); process.exit(1); }
console.log(`${total} shipped packages, all on the licence allow-list`);
