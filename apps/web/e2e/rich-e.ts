/**
 * Group E (connect and govern) fixtures for the fidelity harness: integrations, MCP servers, API keys, triggers and deliveries,
 * in the shape of the Control Room prototype's sample data. Merged into richOverrides(); changes no e2e default.
 */
import { INTEGRATION_TYPES } from "@gantry/domain";
import { fulfillJson, type Handler } from "./fixtures";

const NOW = Date.parse("2026-01-15T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const inst = (id: string, type: string, name: string, projects: "all" | string[], ago: number, status = "healthy", connected = true) => ({
  id, type, name, config: {}, secretMask: "••••a91c", status, connected, projects, lastSync: NOW - ago, createdBy: "p-admin", createdAt: NOW - 40 * DAY, version: 1,
});

export function richGroupE(): Record<string, Handler> {
  const ov: Record<string, Handler> = {};
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
  return ov;
}
