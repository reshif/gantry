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
  { id: "NR-4", event: "question", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }], template: "question", cond, enabled: false, fields },
  // group connect: the rest of the prototype's matrix defaults (submitted, gate.decided, kill, trust.changed)
  { id: "NR-5", event: "submitted", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }, { channel: "email", target: "ops@acme.dev", integration: "i5" }], template: "submitted", cond, enabled: true, fields },
  { id: "NR-6", event: "gate.decided", dest: [{ channel: "email", target: "ops@acme.dev", integration: "i5" }], template: "decided", cond, enabled: true, fields },
  { id: "NR-7", event: "kill", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }, { channel: "email", target: "ops@acme.dev", integration: "i5" }, { channel: "paging", target: "oncall", integration: "i6" }], template: "incident", cond, enabled: true, fields },
  { id: "NR-8", event: "trust.changed", dest: [{ channel: "slack", target: "#factory-gates", integration: "i3" }], template: "submitted", cond, enabled: true, fields },
];

export function richGroupE(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
  ov["projects/payments/routes"] = (r) => fulfillJson(r, routesE.map((x) => ({ ...x, version: 1 })));
  ov["POST card-templates/preview"] = (r) =>
    fulfillJson(r, {
      ok: true,
      sample: { event: "gate.waiting", template: "gate", tone: "wait", head: "Gate G5 is waiting", body: "Rate limit the payout API per merchant needs 1 more approval.", woId: "WO-1004", title: "Rate limit the payout API per merchant", repo: "acme/payments-api", cls: "feature", clsName: "Feature", prio: "P1", approvers: "Meera Iyer", gate: { id: "G5", label: "G5", name: "Review and merge" }, instance: null, link: "https://gantry.example/wo/WO-1004", project: { id: "payments", key: "PAY", name: "Payments Platform" }, at: NOW },
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
      { ...inst("i3", "slack", "Slack", "all", 13 * MIN), config: { defaultChannel: "#factory-gates", workspace: "acme" } },
      inst("i4", "teams", "Microsoft Teams", ["risk"], 11 * MIN, "degraded"),
      inst("i5", "email", "Email (SMTP)", "all", 5 * MIN),
      inst("i6", "paging", "On-call paging", "all", 32 * MIN),
      inst("i7", "webhook", "Signed webhook", ["data-platform"], 27 * MIN, "failing"),
      inst("i8", "jira", "Jira-style tracker", ["payments", "storefront"], 58 * MIN),
      inst("i9", "ci", "CI runner (generic)", "all", 18 * MIN),
    ]);
  const tool = (name: string, write: boolean, allowed = true) => ({ name, write, allowed, hint: write ? "write" : "read", description: name, hash: "h-" + name });
  const mcp = (id: string, name: string, url: string, sens: string, tools: Array<ReturnType<typeof tool> & { changed?: boolean }>, health = "healthy") => ({
    id, name, transport: "http", url, auth: "oauth", authMask: "••••", health, sensitivity: sens, writeGate: true, tools, authMode: "bearer", protocolRevision: "2025-06-18", enabled: true, version: 1, projects: "all", repos: "all", agents: "all",
  });
  const mcpAgents = (a: string[] | "all") => a;
  ov["mcp/servers"] = (r) =>
    fulfillJson(r, [
      { ...mcp("mcp-issues", "Issue tracker", "https://mcp.issues.acme.dev/v1", "internal", [tool("search_issues", false), tool("get_issue", false), { ...tool("create_issue", true), changed: true }, tool("comment_issue", true)]), agents: mcpAgents(["ag-intake", "ag-research", "ag-plan"]), discoveredAt: NOW - 3 * HOUR },
      { ...mcp("mcp-docs", "Docs and wiki", "https://mcp.wiki.acme.dev", "internal", [tool("search_pages", false), tool("get_page", false), tool("update_page", true)]), auth: "API key", authMode: "header", agents: mcpAgents(["ag-intake", "ag-research", "ag-plan"]) },
      { ...mcp("mcp-observe", "Observability", "https://mcp.obs.acme.dev", "internal", [tool("query_metrics", false), tool("list_alerts", false), tool("get_trace", false)]), agents: mcpAgents(["ag-intake", "ag-research", "ag-plan"]) },
      { ...mcp("mcp-apicat", "API catalogue", "https://mcp.api.acme.dev", "internal", [tool("search_apis", false), tool("get_schema", false)], "degraded"), auth: "API key", authMode: "header", agents: mcpAgents(["ag-intake", "ag-research", "ag-plan"]) },
      { ...mcp("mcp-deploy", "Deploy tool", "https://mcp.deploy.acme.dev", "restricted", [tool("list_releases", false), tool("get_release", false), tool("trigger_deploy", true, false)]), agents: mcpAgents(["ag-close"]) },
    ]);
  const key = (id: string, name: string, project: string, actions: string[], created: number, used: number | null, revoked = false) => ({ id, name, prefix: "gk_live_" + id.slice(-1) + "x2f…", project, actions, created: NOW - created, lastUsed: used === null ? null : NOW - used, revoked, by: "p-admin" });
  ov["api-keys"] = (r) =>
    fulfillJson(r, [
      key("k1", "Jira bridge", "payments", ["wo.submit", "wo.read"], 64 * DAY, 25 * MIN),
      key("k2", "Ops runbook bot", "storefront", ["wo.submit", "wo.read"], 41 * DAY, 3 * HOUR),
      key("k3", "Release dashboard", "payments", ["wo.read"], 27 * DAY, 15 * HOUR),
      key("k4", "Support console", "internal-tools", ["wo.submit"], 88 * DAY, 2 * DAY, true),
    ]);
  ov["api-config"] = (r) => fulfillJson(r, { rateLimit: 600, burst: 60, idempotencyHours: 24, webhookSigning: "hmac-sha256", triggersEnabled: true });
  // runs ascend in time (the drawer shows the newest first): the newest is 1d ago and its source is the prototype's acme/payments-api#837
  const trig = (id: string, name: string, project: string, type: string, enabled: boolean, n: number, source?: string) => ({
    id, project, type, name, enabled, who: "org", reply: "Thanks. Gantry opened {wo} and will ask any questions here.", dedupe: true, repos: "all", ...(source ? { source } : {}),
    runs: Array.from({ length: n }, (_, j) => { const k = n - j; return { at: NOW - k * DAY, outcome: "created", wo: `WO-10${10 + k * 4}`, source: `acme/${project === "payments" ? "payments-api" : project}#${800 + k * 37}` }; }),
  });
  ov["triggers"] = (r) =>
    fulfillJson(r, [
      trig("TR-1", "Issues labelled factory", "payments", "issue", true, 6),
      trig("TR-2", "/factory fix on PRs", "payments", "comment", true, 3),
      trig("TR-3", "Weekly dependency chores", "payments", "schedule", true, 9),
      trig("TR-4", "Failing CI on main", "storefront", "ci", true, 4),
      trig("TR-5", "Compliance issues", "risk", "issue", false, 0),
      trig("TR-6", "Jira issues labelled gantry", "internal-tools", "issue", true, 5, "i8"),
    ]);
  const ev = ["submitted", "question", "gate.waiting", "gate.decided", "stuck", "done", "kill", "trust", "mcp"];
  const ch = ["slack", "email", "teams", "pager"];
  const tg = ["#factory-gates", "#payments-line", "ops@acme.dev", "oncall"];
  // group connect: per-connection deliveries and test results, the way the prototype drawers read them
  ov["POST integrations/i7/test"] = (r) => fulfillJson(r, { ok: false, test: { ok: false, ms: 0, error: "HTTP 503" }, msg: "HTTP 503" });
  for (const id of ["i1", "i2", "i3", "i4", "i5", "i6", "i8", "i9"]) ov[`POST integrations/${id}/test`] = (r) => fulfillJson(r, { ok: true, test: { ok: true, ms: 84 }, msg: "ok" });
  ov["deliveries"] = (r) =>
    new URL(r.request().url()).searchParams.get("integration") === "i7"
      ? fulfillJson(r, Array.from({ length: 5 }, (_, i) => ({ id: `DLV-i7-${i}`, at: NOW - (i + 1) * 9 * MIN, project: "data-platform", event: "gate.waiting", channel: "webhook", target: "audit-lake", status: "failed", attempts: 3, error: "HTTP 503 from the target", state: "dead" })))
      : fulfillJson(r, Array.from({ length: 30 }, (_, i) => {
      const dead = i === 4 || i === 11;
      const retrying = i === 7;
      return { id: `DLV-${5112 - i}`, at: NOW - i * 17 * MIN, project: "payments", event: ev[(i * 4) % 9], channel: ch[i % 4], target: tg[(i * 3) % 4], status: dead || retrying ? "failed" : "delivered", attempts: dead ? 3 : 1, error: dead ? "HTTP 503" : "", state: dead ? "dead" : retrying ? "failed" : "sent" };
    }));
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
  for (const pe of PEOPLE) {
    ov[`people/${pe[0]}/effective-permissions`] = (r) => {
      const projs = [{ id: "payments", name: "Payments Platform" }, { id: "storefront", name: "Storefront" }];
      const acts = ACTIONS.slice(0, 12).map((a) => ({ id: a.id, name: a.name, group: a.group, scope: a.scope }));
      const m = matrixE().matrix[pe[3]] ?? {};
      const cells: Record<string, Record<string, [0 | 1, string, string[]?]>> = {};
      for (const a of acts) {
        cells[a.id] = {};
        for (const pr of projs) cells[a.id]![pr.id] = [m[a.id] ? 1 : 0, "MATRIX", ["direct"]];
      }
      const factory: Record<string, { allowed: boolean; reason: string; rule: { id: string; name?: string } }> = {};
      for (const a of ACTIONS.filter((x) => x.scope === "factory").slice(0, 6)) factory[a.id] = { allowed: !!m[a.id], reason: m[a.id] ? "Granted by the role." : "The role does not include it.", rule: { id: "MATRIX" } };
      return fulfillJson(r, { person: pe[0], at: NOW, projects: projs, actions: acts, cells, teams: { [pe[4]]: TEAMS.find((t) => t.id === pe[4])?.name ?? pe[4] }, grants: [{ role: pe[3], roleName: ROLES.find((x) => x.id === pe[3])?.name ?? pe[3], scope: "factory", via: null }], rules: { MATRIX: { kind: "matrix", name: "Role matrix" } }, factory });
    };
  }
  ov["access/matrix"] = (r) => fulfillJson(r, matrixE());
  ov["policies"] = (r) =>
    fulfillJson(r, [
      { id: "POL-101", name: "Release window", effect: "deny", enabled: true, roles: ["release_manager", "project_admin"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [0, 6], from: "00:00", to: "23:59" }, oncallOnly: false, version: 1 },
      { id: "POL-102", name: "On-call may stop the line", effect: "allow", enabled: true, roles: ["engineer"], actions: ["kill.project"], where: {}, when: null, oncallOnly: true, extend: true, version: 1 },
    ]);
  ov["freezes"] = (r) => fulfillJson(r, []);
  ov["security"] = (r) =>
    fulfillJson(r, { sso: { provider: "Okta", domain: "acme.dev", enforced: true, entity: "https://acme.okta.com/app/gantry" }, mfa: { policy: "admins", methods: ["totp", "webauthn"] }, sessionHours: 12, idleMin: 30, domains: ["acme.dev"], ipAllow: ["10.0.0.0/8", "203.0.113.0/24"], restoreFactoryNeedsTwo: true, killNeedsStepUp: true, stepUpWindowMinutes: 15, githubLogin: false, researchHosts: [], chatCapUsdPerDay: null, version: 3 });
  ov["sessions"] = (r) =>
    fulfillJson(r, PEOPLE.slice(0, 8).map((p, i) => ({ id: `s${i}`, person: p[0], method: "sso", device: ["Chrome on macOS", "Firefox on Linux", "Safari on iOS", "Edge on Windows"][i % 4], ip: `203.0.113.${10 + i}`, started: NOW - (i + 1) * 3 * HOUR, lastSeen: NOW - i * 11 * MIN, revoked: false, current: i === 0 })));
  ov["signins"] = (r) =>
    fulfillJson(r, PEOPLE.slice(0, 8).map((p, i) => ({ at: NOW - i * 41 * MIN, person: p[0], email: `${p[0].slice(2)}@acme.dev`, method: "sso", outcome: i === 5 ? "failure" : "success", reason: i === 5 ? "MFA code wrong" : "", ip: `203.0.113.${10 + i}`, device: "Chrome on macOS" })));
  const ACTIONS_E = [["access.role.grant", "person p-hana", "access", "ok"], ["config.route.save", "route NR-2", "config", "ok"], ["auth.signin", "session s3", "auth", "ok"], ["gate.approve", "WO-1004 G5", "approvals", "ok"], ["policy.save", "POL-101", "access", "denied"], ["integration.test", "Slack", "integrations", "ok"], ["wo.submit", "WO-1071", "flow", "ok"], ["api.key.create", "Release dashboard", "api", "ok"], ["security.set", "idleMin", "config", "ok"], ["kill.project", "search", "kill", "ok"]];
  ov["audit"] = (r) => {
    const items = Array.from({ length: 30 }, (_, i) => {
      const a = ACTIONS_E[i % ACTIONS_E.length]!;
      const who = PEOPLE[i % 12]!;
      return { id: 5200 - i, seq: 5200 - i, at: NOW - i * 23 * MIN, actor: who[0], actorKind: "human", actorName: who[1], action: a[0], target: a[1], where: "payments", project: "payments", category: a[2], outcome: a[3], via: "web", channel: "web", before: null, after: null, entity: null, digest: "e3b0c44298fc1c14", prev: "9f86d081884c7d65" };
    });
    return fulfillJson(r, { items, next: null, total: 5200, summary: { entries: 5200, denied: 14, changes: 212, head: "e3b0c44298fc1c14", categories: { access: 600, config: 900, auth: 1200, flow: 1500, approvals: 700, api: 300 }, topics: {}, facets: { outcomes: ["ok", "denied"], channels: ["web", "api"], actors: PEOPLE.slice(0, 12).map((p) => ({ id: p[0], name: p[1] })) } } });
  };
  ov["audit/verify"] = (r) => fulfillJson(r, { ok: true, checked: 5200, head: "e3b0c44298fc1c14" });
  ov["system/health"] = (r) =>
    fulfillJson(r, {
      at: new Date(NOW).toISOString(),
      services: [["api", "API", 42], ["worker", "Worker", null], ["db", "Database", 6], ["runner", "Runner pool", null], ["edge", "MCP edge", 88], ["stream", "Live stream", 12]].map(([id, name, ms], i) => ({ id, name, status: i === 4 ? "degraded" : "ok", detail: i === 4 ? "p95 4.2 s on discovery" : "healthy", latencyMs: ms, heartbeatAgeSeconds: id === "worker" ? 6 : null })),
      backup: { status: "ok", at: new Date(NOW - 5 * HOUR).toISOString(), ageHours: 5, set: "nightly-2026-01-15", detail: "Encrypted, verified" },
      drill: { status: "ok", at: new Date(NOW - 3 * DAY).toISOString(), ageHours: 72, set: "nightly-2026-01-12", seconds: 412, failedChecks: 0, detail: "Restored and checked" },
      outbox: { counts: { pending: 2, sending: 0, delivered: 1840, dead: 1 }, oldestPendingSeconds: 40, dead: [{ id: "ob-9", destination: "webhook data-platform", scope: "project", attempts: 5, maxAttempts: 5, lastError: "HTTP 503", createdAt: new Date(NOW - 6 * HOUR).toISOString(), failedAt: new Date(NOW - 2 * HOUR).toISOString() }] },
      jobs: { counts: { queued: 3, running: 4, done: 2210, dead: 0 }, stuck: [], runningLongMinutes: 45, dead: [], deadWindowHours: 24 },
      runStarts: { windowMinutes: 60, failed: 0, reasons: [] },
    });
  // ---- gov2 fixtures (Security, Audit, System health): stuck jobs and a second dead letter so the prototype's lists render ----
  ov["system/health"] = (r) => {
    return fulfillJson(r, {
      at: new Date(NOW).toISOString(),
      services: [["api", "API", 84, "p95 84ms"], ["worker", "Worker", null, "7 of 8 busy"], ["orch", "Orchestrator", null, "queue 12"], ["db", "Database", 6, "replica lag 0.2s"], ["stream", "Event stream (SSE)", 12, "1,204 clients"], ["outbox", "Outbox dispatcher", null, "2 dead letters"], ["git", "Git provider link", 40, "rate 61%"], ["sandbox", "Build sandboxes", null, "3 of 12 free"]].map(([id, name, ms, detail], i) => ({ id, name, status: id === "outbox" ? "degraded" : "ok", detail, uptime30d: [99.98, 99.9, 99.95, 100, 99.9, 98.7, 99.7, 99.8][i], latencyMs: ms, heartbeatAgeSeconds: id === "worker" ? 4 : null })),
      backup: { status: "ok", at: new Date(NOW - 5 * HOUR).toISOString(), ageHours: 5, set: "nightly-2026-01-15", detail: "Encrypted, verified" },
      drill: { status: "ok", at: new Date(NOW - 9 * DAY).toISOString(), ageHours: 216, set: "nightly-2026-01-12", seconds: 840, failedChecks: 0, detail: "Restored and checked" },
      outbox: { counts: { pending: 2, sending: 0, delivered: 1840, dead: 2 }, oldestPendingSeconds: 40, dead: [
        { id: "ob-9", destination: "webhook data-platform", scope: "project", attempts: 5, maxAttempts: 5, lastError: "HTTP 503", createdAt: new Date(NOW - 6 * HOUR).toISOString(), failedAt: new Date(NOW - 2 * HOUR).toISOString() },
        { id: "ob-12", destination: "notify.slack", scope: "factory", attempts: 5, maxAttempts: 5, lastError: "channel_not_found", createdAt: new Date(NOW - 4 * HOUR).toISOString(), failedAt: new Date(NOW - 3 * HOUR).toISOString() },
      ] },
      jobs: { counts: { queued: 3, running: 4, done: 2210, dead: 0 }, runningLongMinutes: 120, stuck: [
        { id: "j-1", queue: "flow", kind: "flow.advance", attempts: 2, maxAttempts: 5, owner: "w1", startedAt: new Date(NOW - 3 * HOUR).toISOString(), leaseUntil: new Date(NOW - 2 * HOUR).toISOString(), reason: "lease_expired", lastError: null, workOrder: "WO-1006", project: "payments", station: "spec" },
        { id: "j-2", queue: "run", kind: "run.start", attempts: 1, maxAttempts: 5, owner: "w2", startedAt: new Date(NOW - 7 * HOUR).toISOString(), leaseUntil: null, reason: "running_long", lastError: null, workOrder: "WO-1014", project: "payments", station: "build" },
      ], dead: [], deadWindowHours: 24 },
      runStarts: { windowMinutes: 60, failed: 0, reasons: [] },
    });
  };
  ov["sessions"] = (r) =>
    fulfillJson(r, PEOPLE.slice(0, 10).map((p, i) => ({ id: `ses-${i}`, person: p[0], method: "sso", device: ["Chrome 141 / macOS", "Firefox 139 / Linux", "Safari 19 / iOS", "Chrome 141 / Windows"][i % 4], ip: `10.${(i * 7) % 40}.${(i * 53) % 250}.${2 + i * 11}`, started: NOW - (i + 1) * 70 * MIN, lastSeen: NOW - i * 11 * MIN, revoked: false, current: i === 0 })));
  ov["stops"] = (r) => fulfillJson(r, { items: [] });
  // ---- end gov2 fixtures ----
  ov["workload"] = (r) => {
    const rows = PEOPLE.filter((p) => p[6] === "active").slice(0, 10).map((p, i) => ({ person: p[0], name: p[1], team: p[4], waiting: (i * 3) % 5, glass: (i * 2) % 4, approvals: 12 + i * 3, perDay: 1.5 + (i % 4) * 0.7, answered: 4 + i, waitN: 10 + i, medianResponseMin: 25 + i * 11, afterHours: i % 3, n: 14 + i, sole: i % 4 === 0 ? 1 : 0, minutes: 120 + i * 35, away: null, oncall: i === 3, waitingGates: [], recent: [] }));
    return fulfillJson(r, {
      at: NOW, days: 7, scope: "all", minN: 5, projects: [{ id: "payments", name: "Payments Platform" }, { id: "storefront", name: "Storefront" }], factoryWide: true, ids: [],
      totals: { gatesWaiting: 7, soleGates: 2, noneGates: 0, timedN: 40, medianWaitMin: 130, acts: 96, afterHours: 11, minutes: 2840 },
      rows,
      teams: TEAMS.map((t, i) => ({ team: t.id, name: t.name, people: t.members, waiting: i + 1, approvals: 20 + i * 8, answered: 9 + i, minutes: 600 + i * 120, waitN: 12, medianResponseMin: 40 + i * 15, afterHours: i, n: 20, sole: i % 2 })),
      byCls: [{ key: "feature", minutes: 1200, workOrders: 18, perWO: 66 }, { key: "bug", minutes: 800, workOrders: 22, perWO: 36 }],
      byProject: [{ key: "payments", minutes: 1500, workOrders: 20, perWO: 75 }, { key: "storefront", minutes: 900, workOrders: 14, perWO: 64 }],
      bottlenecks: [{ project: "payments", gate: "G5", decisions: 14, medianWaitMin: 190, open: 3, oldestMin: 300, station: "review", minEligible: 1 }],
      needsPerson: [],
      suggestions: [{ key: "s1", kind: "approver", icon: "people", weight: 3, text: "Review and merge on Payments Platform has one eligible approver (Meera Iyer).", action: { id: "wl-sg-1", label: "Open approver rules", type: "config", project: "payments", gate: "G5" } }],
    });
  };
  return ov;
}
