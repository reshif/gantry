// TEST ONLY: spec 5.4 T12 over EVERY state-changing /api/v1 route found in services/api/src/routes (wave 4 included), as the least-privileged signed-in person.
// A 2xx is listed for triage (a person's own preference or link request may legitimately succeed); the database state counters must not change otherwise.
// Usage: node t12-all.mjs [user]   (default arjun: engineer on storefront and growth-experiments only)
import { readdirSync, readFileSync } from "node:fs";
import { session, close, q, log } from "./lib4.mjs";

const user = process.argv[2] ?? "arjun";
const dir = new URL("../../services/api/src/routes/", import.meta.url);
const routes = new Set();
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
  for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/app\.(post|put|patch|delete)(?:<[^>]*>)?\(\s*"(\/api\/v1[^"]*)"/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
}
const valueFor = (path, name, i, parts) => {
  const prev = parts[i - 1] ?? "";
  if (prev === "work-orders") return "WO-1003";
  if (prev === "gate-instances") return "WO-1003:G3G3s";
  if (prev === "stops") return "project%3Apayments";
  if (prev === "repos") return "payments-api";
  if (prev === "projects") return "payments";
  if (prev === "agents") return "ag-build";
  if (prev === "skills") return "sk-testdesign";
  if (prev === "suites") return "SUITE-BUILD";
  if (prev === "people") return "p-asha";
  if (prev === "roles") return "approver";
  if (prev === "triggers") return "TR-1";
  if (name === "role") return "engineer";
  if (name === "action") return "wo.submit";
  if (name === "kind") return "stations";
  if (name === "skill") return "sk-testdesign";
  return "x";
};
const fill = (p) => { const parts = p.split("/"); return parts.map((s, i) => (s.startsWith(":") ? valueFor(p, s.slice(1), i, parts) : s)).join("/"); };
const counters = () => q(`select (select count(*) from work_orders),(select count(*) from projects),(select count(*) from stops),(select count(*) from roles),(select count(*) from policies),(select count(*) from freezes),(select count(*) from invites),(select count(*) from agents),(select count(*) from skills),(select count(*) from integration_instances),(select count(*) from api_keys),(select count(*) from triggers),(select count(*) from mcp_servers),(select count(*) from vendors),(select count(*) from proposals),(select count(*) from trust_cells),(select count(*) from repos),(select count(*) from suites),(select count(*) from eval_cases)`)[0].join(",");
const deniedCount = () => Number(q(`select count(*) from events where type like '%.denied'`)[0][0]);

const s = await session(user);
const skip = (r) => /\/stream|\/logout|\/hooks\//.test(r);
const list = [...routes].filter((r) => !skip(r)).sort();
log(`${list.length} state-changing routes as ${user}`);
const before = counters(), dBefore = deniedCount();
const rows = [];
for (const r of list) {
  const [method, path] = r.split(" ");
  const res = await s.api(method, fill(path), method === "DELETE" ? undefined : {}, { "idempotency-key": `t12-${Math.random().toString(16).slice(2)}`, "if-match": "1" });
  rows.push({ r, status: res.status, msg: String(res.body?.msg ?? res.body ?? "").slice(0, 80), rule: res.body?.rule?.id ?? "" });
  if (res.status === 429) await new Promise((x) => setTimeout(x, 4000));
}
const after = counters(), dAfter = deniedCount();
const by = {}; for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
for (const r of rows.filter((x) => x.status >= 200 && x.status < 300 || x.status >= 500 || x.status === 429)) console.log(`${r.status} ${r.r}  ${r.msg}`);
console.log(JSON.stringify({ user, endpoints: rows.length, byStatus: by, executed2xx: rows.filter((x) => x.status >= 200 && x.status < 300).map((x) => x.r), serverErrors: rows.filter((x) => x.status >= 500).map((x) => x.r), deniedEventsAdded: dAfter - dBefore, countersBefore: before, countersAfter: after, stateUnchanged: before === after }));
await close();
