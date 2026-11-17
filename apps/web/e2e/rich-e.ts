/**
 * Group E (connect and govern) fixtures for the fidelity harness: integrations, MCP servers, API keys, triggers and deliveries,
 * in the shape of the Control Room prototype's sample data. Merged into richOverrides(); changes no e2e default.
 */
import { ACTIONS, INTEGRATION_TYPES, ROLES } from "@gantry/domain";
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const inst = (id: string, type: string, name: string, projects: "all" | string[], ago: number, status = "healthy", connected = true) => ({
  id, type, name, config: {}, secretMask: "••••a91c", status, connected, projects, lastSync: NOW - ago, createdBy: "p-admin", createdAt: NOW - 40 * DAY, version: 1,
});

const cond = { classes: [] as string[], priority: [] as string[], hours: "any" };
const fields = { title: true, repo: true, class: true, priority: true, approvers: true, link: true };
/** Notification routes of a project (the project fixture and the routes endpoint both serve them). */
export const routesE = [
  { id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }], template: "gate", cond, enabled: true, fields },
  { id: "NR-2", event: "blocked", dest: [{ channel: "paging", target: "oncall", integration: "i6" }, { channel: "slack", target: "#factory-gates", integration: "i3" }], template: "incident", cond: { ...cond, priority: ["P0", "P1"] }, enabled: true, fields },
  { id: "NR-3", event: "released", dest: [{ channel: "email", target: "ops@acme.dev", integration: "i5" }], template: "release", cond: { ...cond, hours: "business" }, enabled: false, fields },
  { id: "NR-4", event: "question", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }], template: "question", cond, enabled: true, fields },
];

export function richGroupE(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  ov["projects/payments/routes"] = (r) => fulfillJson(r, routesE.map((x) => ({ ...x, version: 1 })));
  ov["POST card-templates/preview"] = (r) =>
    fulfillJson(r, {
      ok: true,
      sample: { event: "gate.waiting", template: "gate", tone: "wait", head: "Gate G5 is waiting", body: "Add idempotency keys to refund endpoint needs 1 more approval.", woId: "WO-1004", title: "Add idempotency keys to refund endpoint", repo: "acme/payments-api", cls: "feature", clsName: "Feature", prio: "P1", approvers: "Meera Iyer", gate: { id: "G5", label: "G5", name: "Review and merge" }, instance: null, link: "https://gantry.example/wo/WO-1004", project: { id: "payments", key: "PAY", name: "Payments Platform" }, at: NOW },
      rows: [["Work order", "WO-1004"], ["Class", "Feature"], ["Priority", "P1"]],
      actions: ["approve", "reject", "open"],
      webhook: {},
      email: { subject: "Gate G5 is waiting", text: "", html: "" },
    });
  ov["integration-types"] = (r) => fulfillJson(r, INTEGRATION_TYPES.map((t) => ({ ...t, available: t.available ?? true })));
  ov["integrations"] = (r) =>
    fulfillJson(r, [
      inst("i1", "github", "GitHub (acme)", "all", 60 * MIN),
      inst("i2", "github", "GitHub Enterprise (internal)", ["internal-tools", "partner-api"], 62 * MIN),
      inst("i3", "slack", "Slack", "all", 13 * MIN),
      inst("i4", "teams", "Microsoft Teams", ["risk"], 11 * MIN, "failing"),
      inst("i5", "email", "Email (SMTP)", "all", 5 * MIN),
      inst("i6", "paging", "On-call paging", "all", 32 * MIN),
      inst("i7", "webhook", "Signed webhook", ["data-platform"], 27 * MIN, "failing"),
      inst("i8", "jira", "Jira-style tracker", ["payments", "storefront"], 58 * MIN),
      inst("i9", "ci", "CI runner (generic)", "all", 18 * MIN, "healthy", false),
    ]);
  const tool = (name: string, write: boolean, allowed = true) => ({ name, write, allowed, hint: write ? "write" : "read", description: name, hash: "h-" + name });
  const mcp = (id: string, name: string, url: string, sens: string, tools: ReturnType<typeof tool>[], health = "healthy") => ({
    id, name, transport: "http", url, auth: "oauth", authMask: "••••", health, sensitivity: sens, writeGate: true, tools, authMode: "bearer", protocolRevision: "2025-06-18", enabled: true, version: 1, projects: "all", repos: "all", agents: "all",
  });
  ov["mcp/servers"] = (r) =>
    fulfillJson(r, [
      mcp("m1", "Code search", "https://mcp.acme.dev/code-search", "internal", [tool("search_symbols", false), tool("read_file", false), tool("list_refs", false)]),
      mcp("m2", "Issue tracker", "https://mcp.acme.dev/issues", "internal", [tool("get_issue", false), tool("comment", true), tool("transition", true, false)], "degraded"),
      mcp("m3", "Secrets vault", "https://mcp.acme.dev/vault", "restricted", [tool("read_secret", true, false)]),
      mcp("m4", "Docs", "https://mcp.acme.dev/docs", "public", [tool("search_docs", false), tool("get_page", false)]),
    ]);
  const key = (id: string, name: string, project: string, actions: string[], created: number, used: number | null, revoked = false) => ({ id, name, prefix: "gk_live_" + id.slice(-1) + "x2f…", project, actions, created: NOW - created, lastUsed: used === null ? null : NOW - used, revoked, by: "p-admin" });
  ov["api-keys"] = (r) =>
    fulfillJson(r, [
      key("k1", "Release dashboard", "payments", ["wo.submit", "wo.read"], 30 * DAY, 2 * HOUR),
      key("k2", "Support bot", "storefront", ["wo.read"], 20 * DAY, 3 * DAY),
      key("k3", "CI release hook", "payments", ["wo.submit"], 12 * DAY, 40 * MIN),
      key("k4", "Old import script", "identity", ["wo.submit"], 80 * DAY, 60 * DAY, true),
    ]);
  ov["api-config"] = (r) => fulfillJson(r, { rateLimit: 600, burst: 60, idempotencyHours: 24, webhookSigning: "hmac-sha256", triggersEnabled: true });
  const trig = (id: string, name: string, project: string, type: string, enabled: boolean, n: number) => ({
    id, project, type, name, enabled, who: "org", reply: "Thanks. Gantry opened {wo}.", dedupe: true, repos: "all",
    runs: Array.from({ length: n }, (_, i) => ({ at: NOW - (i + 1) * 6 * HOUR, outcome: "created", wo: `WO-10${10 + i}`, source: `acme/${project}#${800 + i * 37}` })),
  });
  ov["triggers"] = (r) =>
    fulfillJson(r, [
      trig("TR-1", "Label ready-for-gantry", "payments", "issue", true, 6),
      trig("TR-2", "Comment /gantry build", "storefront", "comment", true, 3),
      trig("TR-3", "Nightly dependency sweep", "payments", "schedule", true, 9),
      trig("TR-4", "CI red on main", "identity", "ci", false, 0),
    ]);
  const ev = ["gate.waiting", "stuck", "wo.done", "question", "gate.decided"];
  const ch = ["slack", "email", "paging", "teams", "webhook"];
  ov["deliveries"] = (r) =>
    fulfillJson(r, Array.from({ length: 14 }, (_, i) => ({ id: `DLV-${5112 - i}`, at: NOW - i * 17 * MIN, project: "payments", event: ev[i % 5], channel: ch[i % 5], target: ["#factory-gates", "ops@acme.dev", "oncall", "#risk", "https://hooks.acme.dev/g"][i % 5], status: i % 6 === 3 ? "failed" : "delivered", attempts: 1, error: i % 6 === 3 ? "HTTP 503" : "", state: i % 6 === 3 ? "failed" : "sent" })));
  Object.assign(ov, richGovern());
  return ov;
}

const TEAMS = [
  { id: "platform", name: "Platform", desc: "Shared services and the factory line", members: 6 },
  { id: "growth", name: "Growth", desc: "Storefront and mobile", members: 4 },
  { id: "payments", name: "Payments", desc: "Ledger, payouts and refunds", members: 5 },
  { id: "data", name: "Data", desc: "Data platform and search", members: 3 },
];
const PEOPLE: Array<[string, string, string, string, string, boolean, string]> = [
  ["p-admin", "Asha Raman", "Head of Engineering", "factory_admin", "platform", true, "active"],
  ["p-arjun", "Arjun Mehta", "Frontend Engineer", "engineer", "growth", false, "active"],
  ["p-chloe", "Chloe Martin", "Engineering Lead, Growth", "line_lead", "growth", true, "active"],
  ["p-daniel", "Daniel Okafor", "Factory Manager", "project_admin", "platform", true, "active"],
  ["p-diego", "Diego Alvarez", "Engineering Manager, Data", "line_lead", "data", true, "active"],
  ["p-fatima", "Fatima Zahra", "Senior Engineer", "reviewer", "payments", true, "active"],
  ["p-grace", "Grace Liu", "Security Engineer", "approver", "platform", true, "active"],
  ["p-hana", "Hana Sato", "Engineering Lead, Mobile", "project_admin", "growth", true, "invited"],
  ["p-ines", "Ines Moreau", "Engineering Lead, Internal Tools", "project_admin", "platform", false, "active"],
  ["p-kenji", "Kenji Watanabe", "Release Manager", "release_manager", "platform", true, "active"],
  ["p-kwame", "Kwame Mensah", "Engineering Lead, Partners", "project_admin", "payments", true, "active"],
  ["p-lena", "Lena Fischer", "Engineering Lead, Platform", "project_admin", "platform", true, "active"],
  ["p-meera", "Meera Iyer", "Tech Lead", "line_lead", "payments", true, "active"],
  ["p-noor", "Noor Haddad", "Compliance Analyst", "auditor", "data", false, "active"],
  ["p-omar", "Omar Siddiqui", "QA Engineer", "engineer", "payments", true, "active"],
  ["p-priya", "Priya Nair", "On-call Engineer", "engineer", "platform", true, "active"],
  ["p-rui", "Rui Costa", "Contractor", "viewer", "growth", false, "deactivated"],
  ["p-sara", "Sara Lindqvist", "Product Manager", "viewer", "growth", true, "active"],
  ["p-tomas", "Tomas Novak", "Backend Engineer", "engineer", "data", true, "active"],
  ["p-uma", "Uma Patel", "Support Engineer", "engineer", "payments", true, "active"],
];
const person = (r: (typeof PEOPLE)[number]) => ({ id: r[0], name: r[1], title: r[2], email: `${r[0].slice(2)}@acme.dev`, teams: [r[4]], roles: [{ role: r[3], scope: "factory" }], status: r[6], oncall: r[0] === "p-priya", github: r[0].slice(2), away: null, mfa: r[5], version: 1 });

function matrixE() {
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const ro of ROLES) {
    matrix[ro.id] = {};
    ACTIONS.forEach((a, i) => {
      const on = ro.id === "factory_admin" ? true : ro.id === "auditor" ? a.id === "audit.read" || a.id === "project.view" : ro.id === "viewer" ? a.id === "project.view" : ro.level === "factory" ? false : a.scope === "project" && (i + ro.id.length) % 3 !== 0;
      matrix[ro.id]![a.id] = on;
    });
  }
  return { matrix, roles: ROLES, actions: ACTIONS, version: 7 };
}

export function richGovern(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  ov["people"] = (r) => fulfillJson(r, PEOPLE.map(person));
  ov["teams"] = (r) => fulfillJson(r, TEAMS);
  ov["access/matrix"] = (r) => fulfillJson(r, matrixE());
  ov["policies"] = (r) =>
    fulfillJson(r, [
      { id: "POL-101", name: "Release window", effect: "deny", enabled: true, roles: ["release_manager", "project_admin"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [0, 6], from: "00:00", to: "23:59" }, oncallOnly: false, version: 1 },
      { id: "POL-102", name: "On-call may stop the line", effect: "allow", enabled: true, roles: ["engineer"], actions: ["kill.project"], where: {}, when: null, oncallOnly: true, extend: true, version: 1 },
    ]);
  ov["freezes"] = (r) => fulfillJson(r, []);
  return ov;
}
