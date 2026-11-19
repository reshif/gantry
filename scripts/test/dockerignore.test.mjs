// Every repository path a Dockerfile COPYs must be let through by that Dockerfile's allow-list .dockerignore
// (a "*" first, then "!path" lines). A missing line only shows when the image is built ("not found"), as
// runner/wrapper/bin/git did; this catches it in the script tests.
// Run: node --test "scripts/test/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function dockerfiles() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel, depth + 1);
      else if (e.name === "Dockerfile") out.push(rel);
    }
  };
  walk("", 0);
  return out;
}

/** Repo-relative COPY sources (not --from=stage copies). */
function copySources(file) {
  const srcs = [];
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const m = /^\s*COPY\s+(.*)$/i.exec(line);
    if (!m || /--from=/.test(m[1])) continue;
    const parts = m[1].split(/\s+/).filter((p) => p && !p.startsWith("--"));
    srcs.push(...parts.slice(0, -1));
  }
  return srcs;
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

/** Allow-list form ("*" then "!pattern"): a source is let through when an allow pattern matches it or one of its
 * parents, or (a directory source) when some allow pattern lies inside it. Re-exclusions (test files) are ignored. */
function allowed(patterns, path) {
  const allows = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1).replace(/\/$/, ""));
  const parts = path.split("/");
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  return allows.some((a) => prefixes.some((pre) => globRe(a).test(pre)) || a.startsWith(`${path}/`));
}

for (const file of dockerfiles()) {
  const ignore = join(ROOT, `${file}.dockerignore`);
  if (!existsSync(ignore)) continue;
  const patterns = readFileSync(ignore, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (patterns[0] !== "*") continue;
  test(`${file}: every COPY source is let through by ${file}.dockerignore`, () => {
    const missing = copySources(file).filter((s) => !allowed(patterns, s.replace(/^\.\//, "").replace(/\/$/, "")));
    assert.deepEqual(missing, [], `add "!<path>" lines to ${file}.dockerignore for: ${missing.join(", ")}`);
  });
}
