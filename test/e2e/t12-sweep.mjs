// TEST ONLY: spec 5.4 T12 on the live stack. Signs in (Keycloak, real browser path) as a person with the least privilege (Arjun Mehta: engineer on storefront and
// growth-experiments, nothing on payments or the factory) and calls every state-changing endpoint that is implemented. Every call must be refused: a 2xx is a FAIL.
// Each refusal that came from the decision point must also be audited (an `<action>.denied` event). Usage: node t12-sweep.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const PSQL = "/tmp/claude-0/w3e2e/psql.sh";
const q = (sql) => execFileSync(PSQL, ["-tA", "-F", "|", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("|"));
const routes = JSON.parse(readFileSync("/tmp/claude-0/w3e2e/routes.json", "utf8"));
const WO = process.env.T12_WO ?? "WO-1003", GATE = process.env.T12_GATE ?? "WO-1003:G3G3s";
const params = { ":role": "engineer", ":action": "wo.submit", ":id": "payments", ":kind": "stations", ":sub": "plan" };
const idFor = (path) => {
  if (path.includes("/work-orders/")) return WO;
  if (path.includes("/gate-instances/")) return GATE;
  if (path.includes("/stops/")) return "project%3Apayments";
  if (path.includes("/roles/")) return "approver";
  if (path.includes("/policies/") || path.includes("/freezes/")) return "x";
  if (path.includes("/people/")) return "p-asha";
  if (path.includes("/invites/")) return "x";
  if (path.includes("/sessions/")) return "x";
  if (path.includes("/saved-views/") || path.includes("/templates/")) return "x";
  return "payments";
};
const bodies = {
  "POST /api/v1/projects/:id/work-orders": { repo: "payments-api", title: "T12 probe", description: "x" },
  "POST /api/v1/work-orders/:id/messages": { kind: "answer", text: "x" },
  "POST /api/v1/work-orders/:id/reclassify": { cls: "bug", reason: "x" },
  "POST /api/v1/work-orders/:id/decline": { reason: "x" },
  "POST /api/v1/work-orders/:id/move": { target: "build", reason: "x" },
  "POST /api/v1/work-orders/:id/send-back": { toStation: "plan", note: "x" },
  "POST /api/v1/work-orders/:id/park": { bay: "hold", reason: "x" },
  "POST /api/v1/work-orders/:id/reassign": { agent: "ag-plan" },
  "PUT /api/v1/work-orders/:id/record/summary": { text: "x" },
  "POST /api/v1/stops": { scope: "project", id: "payments", mode: "halt", reason: "T12 probe" },
  "POST /api/v1/stops/:id/restore": { reason: "x" },
  "POST /api/v1/projects": { name: "T12 probe", templateId: "standard" },
  "POST /api/v1/roles": { id: "t12role", name: "T12 role" },
  "POST /api/v1/freezes": { name: "x", repos: "all", from: 1, to: 2 },
  "PUT /api/v1/access/matrix/:role/:action": { on: true },
  "POST /api/v1/invites": { name: "T Twelve", email: "t12@example.com" },
  "POST /api/v1/policies": { name: "x", effect: "deny", roles: ["engineer"], actions: ["wo.submit"] },
  "PATCH /api/v1/policies/:id": { name: "x" },
  "PUT /api/v1/people/:id/teams": { teams: [] },
  "PUT /api/v1/people/:id/oncall": { on: true },
  "PUT /api/v1/people/:id/away": { away: null },
  "POST /api/v1/templates": { fromProject: "payments" },
  "POST /api/v1/saved-views": { name: "x", screen: "portfolio", s: {} },
  "PATCH /api/v1/projects/:id/config": { path: "name", value: "T12 probe" },
  "POST /api/v1/projects/:id/flow/:kind": { def: { name: "x", agent: "ag-plan" } },
  "PATCH /api/v1/projects/:id/flow/:kind/:sub": { move: 1 },
  "PUT /api/v1/projects/:id/approvers/:sub": { value: { required: 1, roles: ["approver"] } },
  "POST /api/v1/projects/:id/archive": { confirmText: "x" },
  "PATCH /api/v1/security": { path: "sessionIdleMin", value: 5 },
};
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto("https://localhost/", { waitUntil: "networkidle" });
await page.getByText("Continue with SSO").first().click();
await page.waitForSelector("input[name=password], #password");
await page.fill("#username, input[name=username]", process.env.T12_USER ?? "arjun");
await page.fill("input[name=password], #password", "gantry-dev");
await page.click("#kc-login, input[type=submit], button[type=submit]");
await page.waitForSelector("text=Jump to or run", { timeout: 30000 });
const me = await (await ctx.request.get("https://localhost/api/v1/me")).json();
const csrf = me.csrf ?? me.session?.csrf;
console.log("signed in as", me.person?.id ?? me.id, "csrf", csrf ? "present" : "MISSING");
const before = Number(q("select count(*) from events where type like '%.denied'")[0][0]);
const stateBefore = q("select (select count(*) from work_orders),(select count(*) from projects),(select count(*) from stops),(select count(*) from roles),(select count(*) from policies),(select count(*) from freezes),(select count(*) from invites)")[0].join(",");
const rows = [];
for (const [method, path] of routes) {
  if (process.env.T12_ONLY && !path.includes(process.env.T12_ONLY)) continue;
  if (process.env.T12_SKIP && path.includes(process.env.T12_SKIP)) continue;
  if (path === "/auth/logout" || path === "/api/v1/can" || path === "/api/v1/access/simulate") continue; // logout ends the probe's own session; can and simulate change nothing
  const key = `${method} ${path}`;
  const url = "https://localhost" + path.replace(/:(\w+)/g, (m, n) => (params[m] && !["id"].includes(n) ? params[m] : n === "id" ? idFor(path) : params[m] ?? "x"));
  const body = bodies[key] ?? {};
  const r = await ctx.request.fetch(url, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json", origin: "https://localhost" }, data: JSON.stringify(body), failOnStatusCode: false });
  let j = {}; try { j = await r.json(); } catch {}
  rows.push({ key, status: r.status(), msg: String(j.msg ?? "").slice(0, 90), rule: j.rule?.id ?? "" });
}
const after = Number(q("select count(*) from events where type like '%.denied'")[0][0]);
const stateAfter = q("select (select count(*) from work_orders),(select count(*) from projects),(select count(*) from stops),(select count(*) from roles),(select count(*) from policies),(select count(*) from freezes),(select count(*) from invites)")[0].join(",");
for (const r of rows) console.log(String(r.status).padEnd(4), r.key.padEnd(62), r.rule.padEnd(10), r.msg);
const ok2xx = rows.filter((r) => r.status >= 200 && r.status < 300);
const denied = rows.filter((r) => r.status === 403);
const other = rows.filter((r) => ![403].includes(r.status) && !(r.status >= 200 && r.status < 300));
console.log(JSON.stringify({ endpoints: rows.length, denied403: denied.length, executedUnexpectedly: ok2xx.map((r) => r.key), notDenied: other.map((r) => `${r.status} ${r.key}`), deniedEventsAdded: after - before, stateBefore, stateAfter, stateUnchanged: stateBefore === stateAfter }));
await browser.close();
