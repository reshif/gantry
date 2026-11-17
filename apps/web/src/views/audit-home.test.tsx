import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import AuditView from "./audit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>) => ({ id, name, title: "", email: `${id}@acme.dev`, teams: [], roles, status: "active", oncall: false, github: "", away: null, version: 1 });
const ASHA = person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]);
const SAM = person("p-sam", "Sam Whitfield", [{ role: "auditor", scope: "factory" }]);
const TOMAS = person("p-tomas", "Tomas Eriksen", [{ role: "engineer", scope: "payments" }]);
const me = (p: ReturnType<typeof person>) => ({ person: p, session: { id: "s1", person: p.id, method: "sso", started: 1, lastSeen: 1, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [], factory: { killed: null }, config: {} });

const row = (seq: number, over: Record<string, unknown> = {}) => ({
  id: seq, seq, at: 1_700_000_000_000 + seq * 60_000, actor: "p-asha", actorKind: "human", actorName: "Asha Raman", action: "role.add", target: "Compliance Officer", where: "factory", project: null, category: "access",
  outcome: "ok", via: "web", channel: "web", before: null, after: null, entity: { type: "role", id: "compliance" }, digest: `${seq}`.padStart(64, "a"), prev: `${seq - 1}`.padStart(64, "b"), ...over,
});
const SUMMARY = { entries: 3, denied: 1, changes: 1, head: "c".repeat(64), categories: { access: 2, config: 1 }, topics: { trust: 0, learning: 0, catalogue: 2, record: 0 }, facets: { outcomes: ["denied", "ok"], channels: ["web"], actors: [{ id: "p-asha", name: "Asha Raman" }] } };

interface Call { method: string; path: string; query: URLSearchParams }
function setup(who: ReturnType<typeof person>, extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me(who) }),
    "GET /api/v1/people": () => ({ body: [ASHA, SAM, TOMAS] }),
    "GET /api/v1/agents": () => ({ body: [] }),
    "GET /api/v1/projects": () => ({ body: [] }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/teams": () => ({ body: [] }),
    "GET /api/v1/templates": () => ({ body: [] }),
    "GET /api/v1/saved-views": () => ({ body: [] }),
    "GET /api/v1/activity": () => ({ body: { items: [row(3, { action: "kill.project", category: "kill", target: "Payments killed", outcome: "ok" })], next: null } }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://x");
      const method = init?.method ?? "GET";
      calls.push({ method, path: u.pathname, query: u.searchParams });
      if (u.pathname === "/api/v1/can") {
        const checks = (JSON.parse(String(init?.body)) as { checks: Array<{ action: string }> }).checks;
        return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: "No role holds it.", needs: "Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
      }
      const h = base[`${method} ${u.pathname}`];
      const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{node}</OverlayProvider></QueryClientProvider>);
}

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Audit", () => {
  const page = (items: unknown[], next: string | null = null, total = items.length) => ({ items, next, total, summary: SUMMARY });

  it("says Not visible to you when the ledger read is refused, and the entry counts are not 0", async () => {
    setup(SAM, { "GET /api/v1/audit": () => ({ status: 403, body: { ok: false, msg: "Needs audit.view." } }) });
    mount(<AuditView />);
    await waitFor(() => expect(document.getElementById("aud-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("aud-empty")).toBeNull();
  });

  it("lists the ledger with counts, outcome chips and digests, and asks the server for filters", async () => {
    const calls = setup(SAM, {
      "GET /api/v1/audit": () => ({ body: page([row(3, { outcome: "denied", action: "policy.edit.denied", target: "action policy.edit" }), row(2, { before: "a", after: "b", category: "config", action: "station.add" }), row(1)]) }),
    });
    mount(<AuditView />);
    expect(await screen.findByText("policy.edit.denied")).toBeTruthy();
    const stat = (label: string) => Array.from(document.querySelectorAll("#aud-stats .stat-tile")).find((t) => t.querySelector(".stat-lbl")?.textContent === label)?.querySelector(".stat-val")?.textContent;
    expect(stat("Head digest")).toBe("cccccccc");
    expect(stat("Denied")).toBe("1");
    expect(document.querySelectorAll("tr[id^=aud-row-]")).toHaveLength(3);
    expect(Array.from(document.querySelectorAll("tr[id^=aud-row-] .chip")).map((c) => c.textContent)).toContain("denied");
    expect(document.querySelectorAll(".aud-has-diff")).toHaveLength(1);
    expect((document.getElementById("aud-cat") as HTMLSelectElement).textContent).toContain("Access (2)");
    // Clicking a category narrows server-side.
    fireEvent.change(document.getElementById("aud-cat")!, { target: { value: "config" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/audit" && c.query.get("category") === "config")).toBe(true));
    // Auditors get the verify button; the note about a limited view is absent.
    expect(document.getElementById("aud-verify")).toBeTruthy();
    expect(document.querySelector(".lock-note")).toBeNull();
  });

  it("debounces the search into the q filter and shows a clear button", async () => {
    const calls = setup(SAM, { "GET /api/v1/audit": () => ({ body: page([row(1)]) }) });
    mount(<AuditView />);
    await screen.findByText("role.add");
    fireEvent.change(document.getElementById("aud-q")!, { target: { value: "slack" } });
    await waitFor(() => expect(calls.some((c) => c.query.get("q") === "slack")).toBe(true));
    expect(document.getElementById("aud-clear")).toBeTruthy();
  });

  it("pages with the cursor", async () => {
    const calls = setup(SAM, {
      "GET /api/v1/audit": (url) => ({ body: new URL(url, "http://x").searchParams.get("cursor") ? page([row(1)], null, 2) : page([row(2)], "2", 2) }),
    });
    mount(<AuditView />);
    await screen.findByText("Compliance Officer");
    fireEvent.click(document.getElementById("aud-ledger-more")!);
    await waitFor(() => expect(document.querySelectorAll("tr[id^=aud-row-]")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/api/v1/audit").pop()?.query.get("cursor")).toBe("2");
    expect(document.getElementById("aud-ledger-more")).toBeNull();
  });

  it("opens the detail drawer with the field diff, chain digests and history", async () => {
    setup(SAM, {
      "GET /api/v1/audit": () => ({ body: page([row(2, { before: '{"a":1}', after: '{"a":2}', category: "config", action: "project.config" })]) }),
      "GET /api/v1/audit/2": () => ({
        body: {
          ...row(2, { before: '{"a":1}', after: '{"a":2}', category: "config", action: "project.config" }), rule: "MATRIX", onBehalfOf: null, topic: null, workOrder: null, session: { id: "sess-1", method: "sso", ip: "1.2.3.4", userAgent: "x", startedAt: 1 },
          request: { id: "req-9", command: "req-9", idempotencyKey: null }, sourceIp: "203.0.113.5", diff: [{ field: "a", before: 1, after: 2, changed: true }], history: [row(1, { action: "role.edit" })],
        },
      }),
    });
    mount(<AuditView />);
    fireEvent.click(await screen.findByLabelText("Open audit entry 2: project.config"));
    const drawer = await waitFor(() => { const d = document.querySelector(".aud-drawer"); if (!d || !d.textContent?.includes("Chain")) throw new Error("not yet"); return d as HTMLElement; });
    expect(within(drawer).getByText("1 of 1 fields changed")).toBeTruthy();
    expect(within(drawer).getByText("203.0.113.5")).toBeTruthy();
    expect(within(drawer).getByText("req-9")).toBeTruthy();
    expect(drawer.querySelector(".digest")?.textContent).toBe("2".padStart(64, "a"));
    expect(within(drawer).getByText("role.edit")).toBeTruthy();
    expect(within(drawer).getByText("Open Access")).toBeTruthy();
  });

  it("tells a person without audit.view that they see their own projects only, and hides verify", async () => {
    setup(TOMAS, { "GET /api/v1/audit": () => ({ body: page([row(1)]) }) }, ["audit.view"]);
    mount(<AuditView />);
    await screen.findByText("role.add");
    await waitFor(() => expect(document.querySelector(".lock-note")?.textContent).toContain("audit.view"));
    expect(document.getElementById("aud-verify")).toBeNull();
  });

  it("shows an empty state, and verify reports the result", async () => {
    setup(ASHA, {
      "GET /api/v1/audit": () => ({ body: { items: [], next: null, total: 0, summary: { ...SUMMARY, entries: 0, denied: 0, changes: 0, categories: {} } } }),
      "GET /api/v1/audit/verify": () => ({ body: { ok: true, checked: 12, msg: "Chain intact: 12 entries verified." } }),
    });
    mount(<AuditView />);
    expect(await screen.findByText("The ledger is empty")).toBeTruthy();
    fireEvent.click(document.getElementById("aud-verify")!);
    expect(await screen.findByText("Chain intact: 12 entries verified.")).toBeTruthy();
  });
});
