import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Audit", () => {
  const page = (items: unknown[], next: string | null = null, total = items.length) => ({ items, next, total, summary: SUMMARY });

  it("shows the locked sheet with a way home when the ledger read is refused, and no entry counts of 0", async () => {
    setup(SAM, { "GET /api/v1/audit": () => ({ status: 403, body: { ok: false, msg: "Needs audit.view." } }) });
    mount(<AuditView />);
    const lock = await screen.findByText("No access to this sheet");
    expect(lock).toBeTruthy();
    fireEvent.click(await screen.findByText("Back to Home"));
    expect(window.location.hash).toBe("#home");
    expect(document.getElementById("aud-empty")).toBeNull();
  });

  it("has the four prototype tiles, no tabs, one flush panel, Export CSV beside Verify chain, and filters in the URL", async () => {
    const calls = setup(SAM, {
      "GET /api/v1/audit": () => ({ body: page([row(3, { outcome: "denied", action: "policy.edit.denied", target: "action policy.edit" }), row(2, { before: "a", after: "b", category: "config", action: "station.add" }), row(1)]) }),
    });
    mount(<AuditView />);
    expect(await screen.findByText("policy.edit.denied")).toBeTruthy();
    const stat = (label: string) => Array.from(document.querySelectorAll("#aud-stats .stat-tile")).find((t) => t.querySelector(".stat-lbl")?.textContent === label)?.querySelector(".stat-val")?.textContent;
    await waitFor(() => expect(stat("Entries")).toBe("3"));
    expect(Array.from(document.querySelectorAll("#aud-stats .stat-lbl")).map((x) => x.textContent)).toEqual(["Entries", "Access changes", "Agent changes", "Failures"]);
    expect(stat("Access changes")).toBe("2");
    expect(document.querySelectorAll("[role=tab]")).toHaveLength(0);
    expect(document.getElementById("aud-export")).toBeTruthy();
    expect(document.getElementById("aud-verify")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("#aud-table th")).map((t) => t.textContent?.replace(/[↑↓]/g, ""))).toEqual(["When", "Actor", "Action", "Target", "Category", "Outcome"]);
    expect(document.querySelectorAll("#aud-table tbody tr")).toHaveLength(3);
    expect(document.querySelector("#aud-table .chip.bad")?.textContent).toBe("denied");
    expect(document.getElementById("aud-count") ?? document.querySelector(".filterbar-count")?.textContent).toBeTruthy();
    expect(document.querySelector(".filterbar-count")?.textContent).toBe("3 entries");
    fireEvent.change(document.getElementById("aud-f-category")!, { target: { value: "config" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/audit" && c.query.get("category") === "config")).toBe(true));
    expect(window.location.search).toContain("cat=config");
    expect(document.querySelector(".lock-note")).toBeNull();
  });

  it("opens the entry drawer from the action button only, not from the row", async () => {
    setup(SAM, {
      "GET /api/v1/audit": () => ({ body: page([row(2, { before: "old", after: "new", category: "config", action: "project.config", target: "Payments" })]) }),
      "GET /api/v1/audit/2": () => ({ body: { ...row(2, { before: "old", after: "new", category: "config", action: "project.config", target: "Payments" }), rule: null, onBehalfOf: null, topic: null, workOrder: null, session: null, request: { id: null, command: null, idempotencyKey: null }, sourceIp: null, diff: null, history: [] } }),
    });
    mount(<AuditView />);
    await screen.findByText("project.config");
    fireEvent.click(document.querySelector("#aud-table tbody tr")!);
    expect(document.querySelector("#layer-drawer aside")).toBeNull();
    fireEvent.click(document.getElementById("aud-row-2")!);
    const drawer = await waitFor(() => { const d = document.querySelector("#layer-drawer aside"); if (!d || !d.textContent?.includes("Digest")) throw new Error("not yet"); return d as HTMLElement; });
    expect(drawer.querySelector(".micro")?.textContent).toBe("LEDGER ENTRY #2");
    expect(drawer.querySelector("h2")?.textContent).toBe("project.config");
    expect(Array.from(drawer.querySelectorAll("dl.kv")[0]!.querySelectorAll("dt")).map((x) => x.textContent)).toEqual(["Target", "Category", "Where", "Via", "Outcome", "Entity"]);
    expect(drawer.querySelector(".diff .d")?.textContent).toBe("\u2212 old");
    expect(drawer.querySelector(".diff .a")?.textContent).toBe("+ new");
    expect(drawer.querySelector("footer")).toBeNull();
  });

  it("debounces the search into the q filter, counts N of M, and Clear resets it", async () => {
    const calls = setup(SAM, { "GET /api/v1/audit": () => ({ body: page([row(1)], null, 1) }) });
    mount(<AuditView />);
    await screen.findByText("role.add");
    expect(document.getElementById("aud-clear")).toBeNull();
    fireEvent.change(document.getElementById("aud-q")!, { target: { value: "slack" } });
    await waitFor(() => expect(calls.some((c) => c.query.get("q") === "slack")).toBe(true));
    expect(document.getElementById("aud-clear")).toBeTruthy();
    fireEvent.click(document.getElementById("aud-clear")!);
    expect((document.getElementById("aud-q") as HTMLInputElement).value).toBe("");
  });

  it("pages 15 rows at a time with Prev and Next, and loads older entries with the cursor", async () => {
    const calls = setup(SAM, {
      "GET /api/v1/audit": (url) => ({ body: new URL(url, "http://x").searchParams.get("cursor") ? page([row(1)], null, 17) : page(Array.from({ length: 16 }, (_, i) => row(100 - i)), "85", 17) }),
    });
    mount(<AuditView />);
    await screen.findAllByText("role.add");
    expect(document.querySelectorAll("#aud-table tbody tr")).toHaveLength(15);
    expect(document.querySelector(".dtable-pager")?.textContent).toContain("1\u201315 of 16");
    fireEvent.click(document.getElementById("aud-table-next")!);
    expect(document.querySelectorAll("#aud-table tbody tr")).toHaveLength(1);
    fireEvent.click(document.getElementById("aud-more")!);
    await waitFor(() => expect(document.querySelector(".dtable-pager")?.textContent).toContain("of 17"));
    expect(calls.filter((c) => c.path === "/api/v1/audit" && c.query.get("limit") === "60").pop()?.query.get("cursor")).toBe("85");
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
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    fireEvent.click(document.getElementById("aud-verify")!);
    expect(await screen.findByText("Chain intact: 12 entries verified.")).toBeTruthy();
  });
});
