import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, defaultMatrix } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken, setStepUpHandler } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import PeopleView from "./people";
import PersonView from "./person";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; ifMatch?: string }

const person = (id: string, name: string, teams: string[], roles: object[]) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams, roles, status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [
  person("p-asha", "Asha Raman", ["platform"], [{ role: "factory_admin", scope: "factory" }]),
  person("p-tomas", "Tomás Ferreira", ["payments"], [{ role: "engineer", scope: "payments" }, { role: "reviewer", scope: "payments", via: "payments" }]),
];
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: id === "payments" ? ["payments"] : [], owner: "p-asha", desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PROJECTS = [project("payments", "Payments Platform"), project("storefront", "Storefront")];
const TEAMS = [
  { id: "payments", name: "Payments", desc: "Cards.", roles: [{ id: "tra-1", role: "reviewer", scope: "payments", grantedBy: "p-asha", expiresAt: null }] },
  { id: "platform", name: "Platform", desc: "Infra.", roles: [] },
];
const ME = { person: PEOPLE[0], session: { id: "s1" }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: PROJECTS, factory: { killed: null }, config: {} };
const ACTIONS = DEFAULT_CATALOG.actions;
const gate = ACTIONS.find((a) => a.id === "gate.approve")!;
const EFF = {
  person: "p-tomas", at: Date.now(), projects: [{ id: "payments", name: "Payments Platform" }], actions: [{ id: gate.id, name: gate.name, group: gate.group, scope: "project" }],
  cells: { [gate.id]: { payments: [1, "MATRIX", ["payments"]] } }, rules: { MATRIX: { kind: "matrix", name: "Role matrix" } }, factory: {}, teams: { payments: "Payments" },
  grants: [],
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/teams": () => ({ body: TEAMS }),
    "GET /api/v1/projects": () => ({ body: PROJECTS }),
    "GET /api/v1/security": () => ({ body: { domains: ["acme.dev"] } }),
    "GET /api/v1/access/matrix": () => ({ body: { matrix: defaultMatrix(), roles: DEFAULT_CATALOG.roles, actions: ACTIONS, version: 1 } }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/people/p-tomas/effective-permissions": () => ({ body: EFF }),
    "GET /api/v1/people/p-asha/effective-permissions": () => ({ body: { ...EFF, person: "p-asha", cells: { [gate.id]: { payments: [1, "MATRIX", ["direct"]] } } } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, ifMatch: (init?.headers as Record<string, string> | undefined)?.["If-Match"] });
    if (u.pathname === "/api/v1/can") {
      const checks = (body as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
    }
    const h = base[`${method} ${u.pathname}`];
    const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
/** The team cards are reached by clicking Teams in the People / Teams switch. */
const openTeams = async () => { await byId("ppl-stats"); fireEvent.click(await byId("ppl-mode-teams")); await byId("ppl-team-new"); };
/** The list page; with a person id, that person's own page. */
function mount(personId?: string) {
  // replaceState, not `location.hash =`: assigning queues a hashchange that lands after the test wrote its ?tab= and wipes it
  if (personId) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#person/${personId}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{personId ? <PersonView /> : <PeopleView />}</OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");

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

describe("People & teams: roles for teams", () => {
  it("says Not visible to you when the people read is refused, and the counts are not 0", async () => {
    setup({ "GET /api/v1/people": () => ({ status: 403, body: { ok: false, msg: "Needs people.view." } }) });
    mount();
    await waitFor(() => expect(document.getElementById("ppl-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.body.textContent).not.toContain("No people yet");
  });

  it("states the default for new people and lists each team's roles", async () => {
    setup();
    mount();
    await openTeams();
    expect((await byId("ppl-defaults")).textContent).toContain("Default for new people: no access until granted.");
    const t = await byId("ppl-tr-payments");
    expect(t.textContent).toContain("Reviewer · Payments Platform");
    expect((await byId("ppl-tr-platform")).textContent).toContain("No roles");
  });

  it("adds a project role to a team through the real endpoint, without Factory Admin on offer", async () => {
    const calls = setup({ "POST /api/v1/teams/platform/roles": () => ({ body: { ok: true, msg: "Platform now has Engineer on Storefront." } }) });
    mount();
    await openTeams();
    fireEvent.click(await byId("ppl-tr-add-platform"));
    const role = (await byId("ppl-tr-role")) as HTMLSelectElement;
    expect(Array.from(role.options).map((o) => o.value)).not.toContain("factory_admin");
    fireEvent.change(role, { target: { value: "engineer" } });
    fireEvent.change(await byId("ppl-tr-scope"), { target: { value: "storefront" } });
    fireEvent.click(await byId("ppl-tr-submit"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "POST", path: "/api/v1/teams/platform/roles", body: { role: "engineer", scope: "storefront" } });
  });

  it("shows the server's message when a grant is refused, and keeps the dialog open", async () => {
    setup({ "POST /api/v1/teams/platform/roles": () => ({ status: 403, body: { ok: false, msg: "Sign in again to continue.", needs: "step_up" } }) });
    mount();
    await openTeams();
    fireEvent.click(await byId("ppl-tr-add-platform"));
    fireEvent.click(await byId("ppl-tr-submit"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toContain("Sign in again"));
  });

  it("removes a team role after confirming, with the grant id", async () => {
    const calls = setup({ "DELETE /api/v1/teams/payments/roles/tra-1": () => ({ body: { ok: true, msg: "Removed Reviewer from Payments." } }) });
    mount();
    await openTeams();
    fireEvent.click(await byId("ppl-tr-rm-payments-tra-1"));
    fireEvent.click(await waitFor(() => within(document.body).getByText("Remove role")));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "DELETE", path: "/api/v1/teams/payments/roles/tra-1" });
  });

  it("locks add and remove with the server's reason when the viewer cannot manage people", async () => {
    const calls = setup({}, ["people.manage"]);
    mount();
    await openTeams();
    const add = (await byId("ppl-tr-add-platform")) as HTMLButtonElement;
    await waitFor(() => expect(add.getAttribute("aria-disabled") === "true" || add.disabled).toBe(true));
    fireEvent.click(await byId("ppl-tr-rm-payments-tra-1"));
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("People & teams: a member's roles and where permissions come from", () => {
  it("separates direct roles from roles inherited via a team", async () => {
    setup();
    window.history.replaceState(null, "", "/?tab=access");
    mount("p-tomas");
    const held = await byId("ppl-roles");
    await waitFor(() => expect(document.getElementById("ppl-roles")?.textContent).toContain("via Payments"));
    expect(held.textContent).toContain("Engineer");
    expect(held.textContent).toContain("Reviewer");
    expect(held.textContent).toContain("via Payments: change it on the team");
  });

  it("marks effective-permission cells with their source", async () => {
    setup();
    window.history.replaceState(null, "", "/?view=detail"); // the grid is the secondary view, off the prototype's Access tab
    mount("p-tomas");
    fireEvent.click(await byId("person-tab-access"));
    const cell = await byId(`ppl-eff-payments-${gate.id.replace(/\./g, "_")}`);
    expect(cell.getAttribute("data-tip")).toContain("Role via Payments.");
    expect(cell.textContent).toContain("allowed, via Payments");
    expect(cell.querySelector(".eff-src")).toBeTruthy();
  });
});

describe("People & teams: default deny", () => {
  it("shows why instead of an empty directory when the viewer has no people.view", async () => {
    setup({}, ["people.view"]);
    mount();
    const e = await byId("people-no-access");
    expect(e.textContent).toContain("No access to people and teams");
    expect(e.textContent).toContain("No role holds people.view.");
    expect(document.getElementById("ppl-invite")).toBeNull();
  });
});

describe("People & teams: deactivate", () => {
  const open = async () => {
    fireEvent.click(await byId("ppl-deactivate"));
    return byId("ppl-off");
  };
  const typeReason = (v: string) => fireEvent.change(document.getElementById("ppl-off-reason")!, { target: { value: v } });
  const keysH: Handler = () => ({ body: [{ id: "k1", name: "CI bot", prefix: "gk_ab12", project: "payments", actions: [], created: 0, lastUsed: null, revoked: false, by: "p-tomas" }] });
  const wo = { id: "WO-9", project: "payments", title: "Fix refund", state: "running", requestedBy: "p-tomas", gates: {} };
  const base = (): Record<string, Handler> => ({
    "GET /api/v1/api-keys": keysH,
    "GET /api/v1/workload": () => ({ body: { rows: [], teams: [], bottlenecks: [], suggestions: [], projects: [], totals: {}, at: 0 } }),
    "GET /api/v1/sessions": () => ({ body: [{ id: "s9", person: "p-tomas", revoked: false, method: "sso", device: "d", ip: "", started: 0, lastSeen: 0 }] }),
    "GET /api/v1/projects/payments/work-orders": () => ({ body: [wo] }),
    "GET /api/v1/projects/storefront/work-orders": () => ({ body: [] }),
  });

  it("lists what the person holds with a consequence for each", async () => {
    setup(base());
    mount("p-tomas");
    const dlg = await open();
    // the prototype dialog: Open work orders, Pending approvals, API keys and Projects owned, a warning banner, then the reason
    await waitFor(() => expect(dlg.textContent).toContain("1 will be reassigned to the project owner"));
    expect(dlg.textContent).toContain("Pending approvals");
    expect(dlg.textContent).toContain("1 revoked");
    expect(dlg.textContent).toContain("Projects owned");
    expect(dlg.querySelector(".banner.warn")?.textContent).toContain("History stays attributed to");
    expect(document.getElementById("ppl-off-submit")?.previousElementSibling?.textContent).toBe("Cancel");
  });

  it("needs a reason of 10 characters and sends nothing until then", async () => {
    const calls = setup(base());
    mount("p-tomas");
    await open();
    typeReason("too short");
    fireEvent.click(await byId("ppl-off-submit"));
    await waitFor(() => expect(document.getElementById("ppl-off-err")?.textContent).toContain("at least 10 characters"));
    expect(writes(calls)).toEqual([]);
  });

  it("says 'Reason is required.' for an empty reason (gov1-056)", async () => {
    const calls = setup(base());
    mount("p-tomas");
    await open();
    fireEvent.click(await byId("ppl-off-submit"));
    await waitFor(() => expect(document.getElementById("ppl-off-err")?.textContent).toBe("Reason is required."));
    expect(writes(calls)).toEqual([]);
  });

  it("shows the server's refusal and rule verbatim", async () => {
    setup({ ...base(), "POST /api/v1/people/p-tomas/deactivate": () => ({ status: 409, body: { ok: false, msg: "Tomás is the only approver for Payments.", rule: { kind: "invariant", id: "INV-14.4", name: "Last approver" } } }) });
    mount("p-tomas");
    await open();
    typeReason("Left the company on Friday");
    fireEvent.click(await byId("ppl-off-submit"));
    await waitFor(() => expect(document.getElementById("ppl-off-err")?.textContent).toContain("Tomás is the only approver for Payments."));
    expect(document.getElementById("ppl-off-err")?.textContent).toContain("[INV-14.4]");
  });

  it("on success sends reason, keepKeys and If-Match, then lists the server's open work with links", async () => {
    const calls = setup({ ...base(), "POST /api/v1/people/p-tomas/deactivate": () => ({ body: { ok: true, msg: "Deactivated.", openWork: [{ id: "WO-9", title: "Fix refund", project: "payments", state: "running", roles: ["assignee"] }, { id: "WO-12", title: "Ship it", project: "payments", state: "gated", roles: ["sole_approver"], gate: "review" }] } }) });
    mount("p-tomas");
    await open();
    typeReason("Left the company on Friday");
    fireEvent.click(await byId("ppl-off-submit"));
    const done = await byId("ppl-off-done");
    expect(done.textContent).toContain("WO-9");
    expect(done.textContent).toContain("It is assigned to them.");
    expect(done.textContent).toContain("Only approver of the review gate.");
    expect(done.querySelector("a")?.getAttribute("href")).toContain("record/WO-9");
    // The result dialog replaces the form: no Deactivate button left, Close is the primary action.
    expect(document.getElementById("ppl-off-submit")).toBeNull();
    expect(document.getElementById("ppl-off-close")?.className).toContain("primary");
    const sent = writes(calls).find((c) => c.path.endsWith("/deactivate"));
    expect(sent?.body).toEqual({ reason: "Left the company on Friday" }) // keys are revoked (the default);
    expect(sent?.ifMatch).toBe("2");
  });

  it("shows the server's list only, never the client preview, after success", async () => {
    setup({ ...base(), "POST /api/v1/people/p-tomas/deactivate": () => ({ body: { ok: true, msg: "Deactivated.", openWork: [] } }) });
    mount("p-tomas");
    const dlg = await open();
    await waitFor(() => expect(dlg.textContent).toContain("1 will be reassigned"));
    typeReason("Left the company on Friday");
    fireEvent.click(await byId("ppl-off-submit"));
    // Nothing left open: the toast is the whole result, no second dialog (gov1-056).
    await waitFor(() => expect(document.getElementById("ppl-off")).toBeNull());
    expect(document.getElementById("ppl-off-done")).toBeNull();
    expect(document.getElementById("ppl-off-close")).toBeNull();
  });

  it("asks for a fresh sign-in through the step-up flow and retries with the same If-Match", async () => {
    let n = 0;
    const calls = setup({ ...base(), "POST /api/v1/people/p-tomas/deactivate": () => (n++ === 0 ? { status: 403, body: { ok: false, msg: "Sign in again.", needs: "step_up", rule: { kind: "step-up", id: "STEP-UP" } } } : { body: { ok: true, msg: "Deactivated.", openWork: [] } }) });
    const asked = vi.fn(async () => ({ ok: true as const }));
    setStepUpHandler(asked);
    mount("p-tomas");
    await open();
    typeReason("Left the company on Friday");
    fireEvent.click(await byId("ppl-off-submit"));
    await waitFor(() => expect(document.getElementById("ppl-off")).toBeNull());
    expect(asked).toHaveBeenCalledTimes(1);
    const sent = writes(calls).filter((c) => c.path.endsWith("/deactivate"));
    expect(sent.map((c) => c.ifMatch)).toEqual(["2", "2"]);
    setStepUpHandler(null);
  });

  it("says a list is not shown when the viewer cannot read it, instead of claiming none", async () => {
    setup({ ...base(), "GET /api/v1/api-keys": () => ({ status: 403, body: { ok: false, msg: "No." } }) });
    mount("p-tomas");
    await open();
    await waitFor(() => expect(document.getElementById("ppl-off-holds")?.textContent).toContain("API keysnot available"));
  });

  it("shows deactivated people muted, below active ones, with Reactivate that sends a reason and If-Match", async () => {
    const off = { ...person("p-ines", "Inés Alvarez", ["payments"], []), status: "deactivated", version: 5 };
    const calls = setup({ "GET /api/v1/people": () => ({ body: [PEOPLE[0], off, PEOPLE[1]] }), "POST /api/v1/people/p-ines/reactivate": () => ({ body: { ok: true, msg: "Active again." } }) });
    mount();
    await openTeams();
    const ines = await byId("ppl-mem-payments-p-ines");
    const tomas = await byId("ppl-mem-payments-p-tomas");
    expect(ines.textContent).toContain("deactivated");
    expect(ines.className).toContain("is-off");
    expect(tomas.compareDocumentPosition(ines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ines.getAttribute("href")).toBe("#person/p-ines");
    cleanup();
    mount("p-ines");
    expect(document.getElementById("ppl-deactivate")).toBeNull();
    fireEvent.click(await byId("ppl-reactivate"));
    const ta = await waitFor(() => { const e = document.querySelector<HTMLTextAreaElement>("dialog textarea, [role=dialog] textarea, .dlg textarea"); if (!e) throw new Error("no reason box"); return e; });
    fireEvent.change(ta, { target: { value: "short" } });
    const ok = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Reactivate" && b.id !== "ppl-reactivate")!;
    fireEvent.click(ok);
    expect(writes(calls)).toEqual([]);
    fireEvent.change(ta, { target: { value: "Back from leave on Monday" } });
    fireEvent.click(ok);
    await waitFor(() => expect(writes(calls).length).toBe(1));
    const sent = writes(calls)[0]!;
    expect(sent.path).toBe("/api/v1/people/p-ines/reactivate");
    expect(sent.body).toEqual({ reason: "Back from leave on Monday" });
    expect(sent.ifMatch).toBe("5");
  });

  it("locks Deactivate for the last Factory Admin with the reason", async () => {
    setup({ "GET /api/v1/me": () => ({ body: { ...ME, person: PEOPLE[1] } }) });
    mount("p-asha");
    const btn = await byId("ppl-deactivate");
    expect(btn.getAttribute("aria-description")).toContain("only Factory Admin");
  });

  it("locks Deactivate on yourself with the reason", async () => {
    setup();
    mount("p-asha");
    const btn = await byId("ppl-deactivate");
    expect(btn.getAttribute("aria-description")).toContain("cannot deactivate yourself");
  });
});

describe("People & teams: one page per person", () => {
  it("sends older #people/<id> links to the person's own page", async () => {
    setup();
    window.location.hash = "#people/p-tomas";
    mount();
    await waitFor(() => expect(window.location.hash).toBe("#person/p-tomas"));
  });

  it("opens a person from a team card, and says so when the id is unknown", async () => {
    setup();
    mount();
    await openTeams();
    expect((await byId("ppl-mem-payments-p-tomas")).getAttribute("href")).toBe("#person/p-tomas");
    cleanup();
    mount("p-nobody");
    expect((await byId("person-missing")).textContent).toContain("Page not found");
  });
});

describe("People: Control room prototype layout (gov1)", () => {
  it("shows one primary header action, a Last seen column, name links to the person page and filters in the URL", async () => {
    setup();
    mount();
    await byId("ppl-table");
    expect(document.getElementById("ppl-invite")).not.toBeNull();
    expect(document.getElementById("ppl-team-new")).toBeNull();
    expect(document.getElementById("ppl-tab-teams")).toBeNull();
    expect(document.getElementById("ppl-table")?.textContent).toContain("Last seen");
    await waitFor(() => expect(document.querySelector("#ppl-table a.rl")?.getAttribute("href")).toMatch(/^#person\//));
    fireEvent.change(await byId("ppl-f-status"), { target: { value: "invited" } });
    await waitFor(() => expect(window.location.search).toContain("st=invited"));
    expect(document.getElementById("ppl-clear-small")).not.toBeNull();
  });

  it("the person page has All people, Deactivate… and Profile / Access / Activity tabs", async () => {
    setup();
    mount("p-tomas");
    await byId("person-tab-access");
    expect(document.body.textContent).toContain("All people");
    expect(document.body.textContent).toContain("Holds right now");
    expect(Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.textContent)).toEqual(expect.arrayContaining(["Profile", "Access", "Activity"]));
  });
});

describe("People: round 3 fixes (gov1)", () => {
  it("has no Manage teams link, the team cards stay at ?view=teams, and a click anywhere on a row opens the person", async () => {
    setup();
    mount();
    await byId("ppl-table");
    expect(document.getElementById("ppl-teams-link")).toBeNull();
    expect(document.querySelector(".ph")?.textContent).not.toContain("Manage teams");
    expect(Array.from(document.querySelectorAll("#ppl-table th .th-arrow")).map((a) => a.textContent)).toContain("↕");
    const mfa = document.querySelector("#ppl-row-p-asha td:nth-child(4)")!;
    fireEvent.click(mfa);
    expect(window.location.hash).toBe("#person/p-asha");
  });

  it("the People / Teams switch reaches the team cards and back by clicking", async () => {
    setup();
    mount();
    await byId("ppl-table");
    expect(document.getElementById("ppl-team-new")).toBeNull();
    await openTeams();
    expect(document.getElementById("ppl-table")).toBeNull();
    fireEvent.click(document.getElementById("ppl-mode-people")!);
    await byId("ppl-table");
    expect(document.getElementById("ppl-invite")).not.toBeNull();
  });

  it("the invite dialog has Name, Email, Role and Team only, and Cancel closes it", async () => {
    setup();
    mount();
    fireEvent.click(await byId("ppl-invite"));
    const dlg = await waitFor(() => { const d = document.querySelector<HTMLElement>("[role=dialog]"); if (!d) throw new Error("no dialog"); return d; });
    expect(Array.from(dlg.querySelectorAll("label")).map((l) => l.textContent?.replace(/\*/g, "").trim())).toEqual(["Full name", "Work email", "Role", "Team"]);
    expect(dlg.textContent).not.toContain("No team");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector("[role=dialog]")).toBeNull());
  });

  it("the person Access tab is one Roles card with one row per role, Change role lists every role, and the grids are not shown", async () => {
    setup();
    mount("p-tomas");
    fireEvent.click(await byId("person-tab-access"));
    await byId("ppl-roles");
    expect(document.querySelectorAll("#ppl-roles tbody tr")).toHaveLength(2); // engineer (direct) and reviewer (via team)
    expect(document.querySelectorAll("#ppl-chrole-btn")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Roles per project");
    expect(document.body.textContent).not.toContain("Effective permissions now");
    expect(document.body.textContent).not.toContain("Factory-wide capabilities");
    fireEvent.click(document.getElementById("ppl-chrole-btn")!);
    const sel = (await byId("ppl-chrole")) as HTMLSelectElement;
    expect(sel.options.length).toBeGreaterThanOrEqual(9); // all roles, including Factory Admin and Auditor
    expect(Array.from(sel.options).map((o) => o.text)).toEqual(expect.arrayContaining(["Factory Admin", "Auditor"]));
  });

  it("the profile card has no Change link on Team", async () => {
    setup();
    mount("p-tomas");
    await byId("ppl-profile");
    expect(document.getElementById("ppl-teams")).toBeNull();
  });
});
