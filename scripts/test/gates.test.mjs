// Tests for the delivery gates: architecture lint rules, the ratchets, the bundle budget and the AGENTS.md enforcement check.
// Run: node --test "scripts/test/*.test.mjs" (also part of `npm test -w @gantry/web`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { check, entryFiles } from "../bundle-budget.mjs";
import { parseRules, repoContext, verify, verifyCheck } from "../check-agents-rules.mjs";
import { report } from "../frontend-dod.mjs";
import { compare, groupOf, pollingCount, ruleIdOf, WEB_SRC } from "../lib/frontend-counts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function lint(code, rel) {
  const eslint = new ESLint({ cwd: ROOT });
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, "apps/web/src", rel) });
  return res.messages.map((m) => ({ id: ruleIdOf(m), severity: m.severity }));
}
const ids = (msgs) => msgs.map((m) => m.id);

test("lint: raw table, button and input are flagged in views, not in ui", async () => {
  const code = "export const V = () => <div><table /><button /><input /><textarea /><select /></div>;";
  const v = ids(await lint(code, "views/x.tsx"));
  assert.deepEqual([v.filter((i) => i === "raw-table").length, v.filter((i) => i === "raw-button").length, v.filter((i) => i === "raw-input").length], [1, 1, 3]);
  const ui = ids(await lint(code, "ui/Thing.tsx"));
  assert.ok(!ui.includes("raw-table") && !ui.includes("raw-button"));
});

test("lint: react-query, api client and ops imports are flagged in views only", async () => {
  const code = 'import { useQuery } from "@tanstack/react-query";\nimport { get } from "../api/client";\nimport { ops } from "../api/ops";\nexport const a = [useQuery, get, ops];';
  const v = ids(await lint(code, "views/x.tsx"));
  for (const t of ["view-import-react-query", "view-import-api-client", "view-import-ops"]) assert.ok(v.includes(t), t);
  assert.ok(!ids(await lint(code, "api/queries.ts")).includes("view-import-ops"));
});

test("lint: literal query keys, role-name literals and failed-read fallbacks are flagged", async () => {
  const code = 'declare const q: { data?: number[] };\nexport const a = { queryKey: ["teams"] };\nexport const b = (r: { role: string }) => r.role === "auditor";\nexport const c = q.data ?? [];';
  const v = ids(await lint(code, "views/x.tsx"));
  for (const t of ["literal-query-key", "role-literal", "data-nullish-empty"]) assert.ok(v.includes(t), t);
});

test("lint: ui must not import views (an error, not a warning)", async () => {
  const m = await lint('import { V } from "../views/home";\nexport const a = V;', "ui/Thing.tsx");
  assert.deepEqual(m.filter((x) => x.id === "ui-imports-views").map((x) => x.severity), [2]);
});

test("lint: dangerouslySetInnerHTML is flagged outside Icon and as-unknown-as everywhere", async () => {
  const html = "export const V = () => <i dangerouslySetInnerHTML={{ __html: 'x' }} />;";
  assert.ok(ids(await lint(html, "ui/Markdown.tsx")).includes("dangerous-html"));
  assert.ok(!ids(await lint(html, "ui/Icon.tsx")).includes("dangerous-html"));
  assert.ok(ids(await lint("export const a = 1 as unknown as string;", "lib/x.ts")).includes("as-unknown-as"));
});

test("lint: jsx-a11y is on for web code", async () => {
  const m = ids(await lint('export const V = () => <img src="a.png" />;', "views/x.tsx"));
  assert.ok(m.includes("jsx-a11y/alt-text"));
});

test("lint: tests are exempt from the architecture rules", async () => {
  const m = ids(await lint("export const V = () => <button />;", "views/x.test.tsx"));
  assert.ok(!m.includes("raw-button"));
});

test("ratchet: a grown count and a stale (shrunk) count are both reported", () => {
  const base = { "raw-table": { "views/a": 2, "views/b": 1 } };
  const r = compare({ "raw-table": { "views/a": 3, "views/b": 0 }, "raw-button": { "views/c": 1 } }, base);
  assert.deepEqual(r.grown.map((d) => `${d.rule}:${d.group}`).sort(), ["raw-button:views/c", "raw-table:views/a"]);
  assert.deepEqual(r.shrunk.map((d) => `${d.rule}:${d.group}`), ["raw-table:views/b"]);
  assert.deepEqual(compare(base, base), { grown: [], shrunk: [] });
});

test("ratchet: files group under their view", () => {
  assert.equal(groupOf(join(WEB_SRC, "views/access.tsx")), "views/access");
  assert.equal(groupOf(join(WEB_SRC, "views/access/Tabs.tsx")), "views/access");
  assert.equal(groupOf(join(WEB_SRC, "ui/Overlay.tsx")), "ui");
});

test("dod: a view passes only with zero violations", () => {
  const rows = report({ "raw-table": { "views/a": 1 }, "jsx-a11y/alt-text": { "views/b": 2 } }, ["views/a", "views/b", "views/c"]);
  assert.deepEqual(rows.map((r) => r.pass), [false, false, true]);
  assert.deepEqual(rows[1].violations, { "jsx-a11y": 2 });
});

test("bundle: entry files come from index.html; over budget fails and a big gain must be locked in", () => {
  const html = '<script type="module" crossorigin src="/assets/i.js"></script><link rel="modulepreload" href="/assets/p.js"><link rel="stylesheet" href="/assets/i.css"><link rel="stylesheet" href="https://fonts.googleapis.com/x">';
  assert.deepEqual(entryFiles(html), { js: ["/assets/i.js", "/assets/p.js"], css: ["/assets/i.css"] });
  const budget = { entryJsGzip: 100_000, entryCssGzip: 50_000 };
  assert.equal(check({ entryJsGzip: 100_001, entryCssGzip: 50_000 }, budget).over.length, 1);
  assert.equal(check({ entryJsGzip: 90_000, entryCssGzip: 50_000 }, budget).under.length, 1);
  assert.deepEqual(check({ entryJsGzip: 99_500, entryCssGzip: 50_000 }, budget), { over: [], under: [] });
});

const REG = { checks: { real: { kind: "file", path: "AGENTS.md" }, ghost: { kind: "file", path: "no/such/file" } } };
const ctx = { read: () => "", exists: (p) => p === "AGENTS.md", workflows: () => [] };

test("agents: a rule with no enforcement, an unknown check and a dead check each fail", () => {
  const doc = "- **X-01** Fine. Enforced by: `real`.\n\n- **X-02** Naked rule with no check.\n\n- **X-03** Unknown. Enforced by: `nope`.\n\n- **X-04** Dead. Enforced by: `ghost`.\n";
  const { rules, problems } = verify(doc, REG, ctx);
  assert.equal(rules.length, 4);
  assert.ok(problems.some((p) => p.startsWith("X-02") && p.includes("names no enforcing check")));
  assert.ok(problems.some((p) => p.startsWith("X-03") && p.includes("not in scripts/enforcement.json")));
  assert.ok(problems.some((p) => p.startsWith("X-04") && p.includes("does not exist")));
  assert.ok(!problems.some((p) => p.startsWith("X-01")));
});

test("agents: a registry check that enforces no rule is reported", () => {
  const { problems } = verify("- **X-01** Fine. Enforced by: `real`.\n", REG, ctx);
  assert.ok(problems.some((p) => p.includes("`ghost`") && p.includes("enforces no rule")));
});

test("agents: multi-line rules are parsed", () => {
  const rules = parseRules("- **G-01** First line\n  continues here. Enforced by: `a`, `b`.\n- **G-02** Next. Enforced by: `c`.\n");
  assert.deepEqual(rules, [{ id: "G-01", checks: ["a", "b"] }, { id: "G-02", checks: ["c"] }]);
});

test("agents: the real AGENTS.md has an enforcing, existing check for every rule", () => {
  const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const { rules, problems } = verify(text, JSON.parse(readFileSync(join(ROOT, "scripts/enforcement.json"), "utf8")), repoContext());
  assert.ok(rules.length >= 20);
  assert.deepEqual(problems, []);
});

test("polling: refetchInterval and setInterval in a view are counted", () => {
  assert.equal(pollingCount("useQuery({ refetchInterval: 5000 }); setInterval(f, 10);"), 2);
  assert.equal(pollingCount("const a = 1; // pollWhenStreamDown"), 0);
});

test("react-router stays removed from the web app", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "apps/web/package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies };
  assert.deepEqual(Object.keys(deps).filter((d) => d.startsWith("react-router")), []);
  const lock = readFileSync(join(ROOT, "package-lock.json"), "utf8");
  assert.ok(!/"node_modules\/react-router(-dom)?"/.test(lock), "react-router is in package-lock.json");
});

test("agents: a `test` check needs the named test to exist in the file", () => {
  const c = { read: () => 'test("named one", () => {})', exists: () => true, workflows: () => [] };
  assert.equal(verifyCheck("x", { kind: "test", path: "t.mjs", name: "named one" }, c), null);
  assert.match(verifyCheck("x", { kind: "test", path: "t.mjs", name: "other" }, c), /no test named/);
  assert.match(verifyCheck("x", { kind: "file", path: "t.mjs", contains: ["named one", "missing"] }, c), /missing/);
});
