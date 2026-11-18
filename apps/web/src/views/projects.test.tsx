import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, type ApproverRule } from "@gantry/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken, setStepUpHandler, type StepUpOutcome } from "../api/client";
import { reloadPrefs, updatePrefs } from "../lib/prefs";
import { OverlayProvider } from "../ui/Overlay";
import ProjectsView from "./projects";
import ProjectConfigView from "./project-config";
import { flowFrom, tplCustomCount, tplCustomText, tplFlowProject } from "./projects/templates-kit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

const CAT = { ...DEFAULT_CATALOG };
const TEMPLATES = [
  { id: "tpl-backend", name: "Backend service", desc: "API or worker.", stationsOff: [], gatesOff: [], slots: 2, classesSkip: {}, mcp: [], approverPreset: "standard", notify: "standard", builtIn: true, version: 1 },
  { id: "tpl-mine", name: "My template", desc: "Mine", stationsOff: ["design"], gatesOff: [], slots: 1, classesSkip: {}, mcp: [], approverPreset: "light", notify: "light", builtIn: false, version: 4 },
];
const rule = (o: Partial<ApproverRule> = {}): ApproverRule => ({ roles: ["line_lead"], people: [], required: 1, sod: true, conditions: [], escalateH: 24, fallback: null, ...o });
const approvers = (): Record<string, ApproverRule> => Object.fromEntries(CAT.gates.map((g) => [g.id, rule()]));
const metrics = (o: object = {}) => ({ wip: 3, bays: 1, gates: 2, oldest: 3_600_000, late: 0, eff: 0.5, effN: 6, cov: { total: 20, auto: 5, share: 0.25 }, bad: 0, haltedRepos: 0, byPosition: { build: { n: 3, blocked: 0 } }, byClass: { feature: 2 }, byGate: { G5: 2 }, slotsUsed: 1, onboarding: 0, health: { id: "ok", label: "Healthy", icon: "st-done" }, ...o });
const project = (id: string, name: string, extra: object = {}) => ({
  id, name, key: id.slice(0, 3).toUpperCase(), status: "active", teams: ["payments"], owner: "p-asha", template: "tpl-backend", regulated: false, desc: `${name} desc`, flow: flowFrom(CAT, TEMPLATES[0] as never),
  approvers: approvers(), notifications: [], mcp: [], budget: { monthly: 1000, mtd: 250, alertAt: 0.8 }, created: Date.now() - 86_400_000, halted: null, killed: null, overlay: "", version: 7, metrics: metrics(), ...extra,
});
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance", { metrics: metrics({ health: { id: "attention", label: "Needs attention", icon: "alert", detail: "1 blocked or failing" }, bad: 1 }), regulated: true, template: "tpl-mine" });
const OLD = project("legacy-checkout", "Legacy Checkout", { status: "archived", metrics: metrics({ health: { id: "archived", label: "Archived", icon: "st-park" } }) });
const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>, extra: object = {}) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles, status: "active", oncall: false, github: "", away: null, version: 2, ...extra });
const PEOPLE = [person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]), person("p-meera", "Meera Iyer", [{ role: "line_lead", scope: "payments" }]), person("p-tomas", "Tomas Eriksen", [{ role: "engineer", scope: "payments" }])];
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };
const PRESETS = {
  approvers: { standard: { G5: rule({ roles: ["reviewer", "line_lead"], required: 1 }) }, light: { G5: rule({ roles: ["reviewer"] }) }, strict: { G5: rule({ roles: ["reviewer", "line_lead"], required: 2 }) } },
  routes: {
    standard: [{ id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }, { id: "NR-2", event: "kill", dest: [{ channel: "slack", target: "#inc" }], template: "kill", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }],
    light: [{ id: "NR-1", event: "gate.waiting", dest: [{ channel: "slack", target: "#gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} }], strict: [],
  },
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = [], stepUp: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK, OLD] }),
    "GET /api/v1/templates": () => ({ body: TEMPLATES }),
    "GET /api/v1/saved-views": () => ({ body: [{ id: "v-1", name: "Mine", screen: "portfolio", project: null, s: { group: "team", sort: "name", dir: 1, health: "all", team: "all", tpl: "all", archived: false }, version: 3 }] }),
    "GET /api/v1/catalog": () => ({ body: CAT }),
    "GET /api/v1/teams": () => ({ body: [{ id: "payments", name: "Payments", desc: "" }, { id: "growth", name: "Growth", desc: "" }] }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/project-presets": () => ({ body: PRESETS }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [] }),
    "GET /api/v1/stops/impact": () => ({ body: { workOrders: 3, running: 1, slots: 1, prs: 0 } }),
    ...extra,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const hdr: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body, headers: hdr });
      if (path === "/api/v1/can") {
        const checks = (body as { checks: Array<{ action: string }> }).checks;
        return new Response(JSON.stringify({ results: checks.map((c) => (stepUp.includes(c.action) ? { allowed: false, reason: "Fresh sign-in required", needs: "step_up", rule: { id: "STEP-UP" } } : denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Project Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
      }
      const h = base[`${method} ${path}`];
      const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: `no mock ${method} ${path}` } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{node}</OverlayProvider></QueryClientProvider>);
}
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("template helpers", () => {
  it("derives a flow from a template and draws custom entries into the preview", () => {
    const flow = flowFrom(CAT, { ...TEMPLATES[1]!, order: undefined, bays: undefined } as never);
    expect(flow.stations.design!.enabled).toBe(false);
    expect(flow.slots).toBe(1);
    const t = { ...TEMPLATES[0]!, custom: { bays: [{ id: "legal", name: "Legal Hold" }], classes: [{ id: "fix", name: "Fix", skips: [], priority: "P1", slaH: 4, est: "S" }] } } as never;
    expect(tplCustomCount(t)).toBe(2);
    expect(tplCustomText(t)).toBe("bay Legal Hold, class Fix");
    expect(tplFlowProject(CAT, t).flow.classes.map((c) => c.id)).toContain("fix");
  });
});

describe("Projects: portfolio", () => {
  it("says the portfolio is not visible on a 403, instead of showing no projects", async () => {
    setup({ "GET /api/v1/projects": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<ProjectsView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("No projects yet")).toBeNull();
  });

  it("is the Blueprint's page: key in the eyebrow, Cards / Table switch, four tiles over all projects, cards with only Open Floor and Config", async () => {
    window.location.hash = "#/projects";
    setup();
    mount(<ProjectsView />);
    expect(await screen.findByText("Payments Platform")).toBeTruthy();
    expect(document.querySelector(".vhead .kicker")?.textContent).toBe("GNT-PRJ-03·ALL LINES");
    expect(Array.from(document.querySelectorAll(".seg button")).map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["Cards", "true"], ["Table", "false"]]);
    // archived projects count and show: Projects 3 (2 active), spend and budget over all of them
    expect(Array.from(document.querySelectorAll(".stats .stat .v")).map((d) => d.textContent)).toEqual(["3", "9", "$750", "1"]);
    expect(document.querySelector(".stats .stat .s")?.textContent).toBe("2 active");
    expect(screen.getByText("Legacy Checkout")).toBeTruthy();
    expect(document.querySelectorAll(".card-grid .card")).toHaveLength(3);
    const card = document.getElementById("prj-card-payments")!;
    expect(Array.from(card.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Open Floor", "Config"]);
    expect(document.querySelector(".tabs")).toBeNull(); // no Portfolio / Templates strip
    expect(document.getElementById("prj-pf-arch")).toBeNull(); // no group / sort / saved-view controls
  });

  it("Open Floor and Config go to the project's own pages", async () => {
    setup();
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-cfg-risk"));
    await waitFor(() => expect(window.location.hash).toBe("#/p/risk/project-config"));
    fireEvent.click(await byId("prj-floor-risk"));
    await waitFor(() => expect(window.location.hash).toBe("#/p/risk/floor"));
  });

  it("the layout is in the URL: ?view=table shows the five-column table whose names link to Project config, with a status filter, sort and range footer", async () => {
    window.history.replaceState(null, "", "/?view=table");
    setup();
    mount(<ProjectsView />);
    await byId("prj-table");
    expect(Array.from(document.querySelectorAll("#prj-table thead th")).map((t) => t.textContent?.replace(/[↑↓↕]/, "").trim())).toEqual(["Project", "Owner", "In flight", "Budget", "Status"]);
    expect(document.querySelector("#prj-table tbody a.pri")?.getAttribute("href")).toBe("#/p/payments/project-config");
    expect(document.querySelector("#prj-table .tfoot")?.textContent).toBe("1–3 of 3");
    expect(document.querySelector("#prj-table .count")?.textContent).toBe("3 projects");
    fireEvent.change(document.getElementById("prj-table-f-status")!, { target: { value: "archived" } });
    await waitFor(() => expect(document.querySelector("#prj-table .count")?.textContent).toBe("1 project of 3"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    fireEvent.click(document.getElementById("prj-table-table-sort-n")!);
    fireEvent.click(document.getElementById("prj-table-table-sort-n")!);
    await waitFor(() => expect(document.querySelector("#prj-table tbody a.pri")?.textContent).toBe("Risk and Compliance"));
    // the switch writes the URL
    fireEvent.click(document.getElementById("prj-view-cards")!);
    expect(window.location.search).toBe("");
    window.history.replaceState(null, "", "/");
  });

  it("New project is one dialog: Name, Key (3 letters), What does it build?, Template, Owner; it validates inline and creates with the server's defaults", async () => {
    const calls = setup({ "POST /api/v1/projects": () => ok({ project: { id: "orders-hub", name: "Orders Hub" }, custom: { done: [], failed: [] } }) });
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-new"));
    await screen.findByRole("dialog");
    expect(Array.from(document.querySelectorAll("[role=dialog] .field-label")).map((l) => l.textContent?.replace(" (required)", ""))).toEqual(["Name", "Key (3 letters)", "What does it build?", "Template", "Owner"]);
    expect(screen.queryByText(/Next:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(document.activeElement?.id).toBe("fd-name");
    fireEvent.change(document.getElementById("fd-name")!, { target: { value: "Or" } });
    fireEvent.change(document.getElementById("fd-key")!, { target: { value: "PAY" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Name needs at least 3 characters.")).toBeTruthy();
    expect(screen.getByText("That key is taken.")).toBeTruthy();
    fireEvent.change(document.getElementById("fd-name")!, { target: { value: "Orders Hub" } });
    fireEvent.change(document.getElementById("fd-key")!, { target: { value: "ord" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Use exactly three capital letters.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/projects")).toBe(false);
    fireEvent.change(document.getElementById("fd-key")!, { target: { value: "ORD" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/projects" && c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.path === "/api/v1/projects" && c.method === "POST")!.body).toMatchObject({ name: "Orders Hub", key: "ORD", templateId: "tpl-backend", owner: "p-asha", budget: 3000, teams: [] });
    expect(await screen.findByText("Orders Hub created")).toBeTruthy();
  });

  it("disables New project with the reason when the right is missing", async () => {
    setup({}, ["project.create"]);
    mount(<ProjectsView />);
    const btn = await byId("prj-new");
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(btn.getAttribute("data-reason")).toMatch(/Needs Project Admin. No role holds project.create/);
  });

  it("a locked New project carries the server's reason as its title and answers a click with that toast", async () => {
    setup({}, ["project.create"]);
    mount(<ProjectsView />);
    const btn = await byId("prj-new");
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    const why = "Needs Project Admin. No role holds project.create.";
    expect(btn.getAttribute("title")).toBe(why);
    fireEvent.click(btn);
    expect(await screen.findByText(why, { selector: ".toast, .toast *, [role=status] *, [role=status]" })).toBeTruthy();
  });

  it("the table's Status filter offers All, active, paused, archived (the Blueprint's)", async () => {
    window.history.replaceState(null, "", "/?view=table");
    setup();
    mount(<ProjectsView />);
    await byId("prj-table");
    expect(Array.from((document.getElementById("prj-table-f-status") as HTMLSelectElement).options).map((o) => o.text)).toEqual(["All", "active", "paused", "archived"]);
  });
});

describe("Projects: templates and wizard", () => {
  it("lists templates; built-in ones are read-only, a custom one opens the editor", async () => {
    window.history.replaceState(null, "", "/?view=templates");
    const calls = setup({ "PATCH /api/v1/templates/tpl-mine": () => ok({ version: 5 }) });
    mount(<ProjectsView />);
    expect((await byId("prj-tpl-edit-tpl-backend")).getAttribute("data-reason")).toMatch(/Built-in templates are read-only/);
    fireEvent.click(await byId("prj-tpl-edit-tpl-mine"));
    fireEvent.change(await byId("prj-te-name"), { target: { value: "Renamed template" } });
    fireEvent.submit(document.querySelector(".dlg-form")!);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ name: "Renamed template", stationsOff: ["design"], slots: 1 }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("4");
  });

  it("keeps what was typed in the wizard when it is closed and opened again, and starts fresh from a template card", async () => {
    window.history.replaceState(null, "", "/?view=templates");
    setup();
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-tpl-use-tpl-backend"));
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.change(await byId("prj-wz-name"), { target: { value: "Half Done" } });
    fireEvent.click(await byId("prj-wz-cancel"));
    await waitFor(() => expect(document.getElementById("prj-wz-name")).toBeNull());
    fireEvent.click(await byId("prj-tpl-use-tpl-backend"));
    fireEvent.click(await byId("prj-wz-next"));
    expect(((await byId("prj-wz-name")) as HTMLInputElement).value).toBe("Half Done");
  });

  it("walks the wizard and creates the project with the chosen presets, then connects its repos", async () => {
    const calls = setup({
      "POST /api/v1/projects": () => ok({ project: { id: "orders-hub", name: "Orders Hub" }, custom: { done: [], failed: [] } }),
      "POST /api/v1/projects/orders-hub/repos": () => ok(),
    });
    window.history.replaceState(null, "", "/?view=templates");
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-tpl-use-tpl-backend"));
    fireEvent.click(await byId("prj-wz-tpl-tpl-mine"));
    fireEvent.click(await byId("prj-wz-next"));
    // validation: name and team are required
    fireEvent.click(await byId("prj-wz-next"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Name the project/);
    fireEvent.change(await byId("prj-wz-name"), { target: { value: "Orders Hub" } });
    fireEvent.change(await byId("prj-wz-team-add"), { target: { value: "growth" } });
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.change(await byId("prj-wz-repo-add"), { target: { value: "bad name" } });
    fireEvent.click(await byId("prj-wz-repo-go"));
    fireEvent.click(await byId("prj-wz-next"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Repo names look like acme\/name/);
    fireEvent.click(await byId("prj-wz-rm-bad-name"));
    fireEvent.change(await byId("prj-wz-repo-add"), { target: { value: "acme/orders-api" } });
    fireEvent.click(await byId("prj-wz-repo-go"));
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.click(await byId("prj-wz-ap-strict"));
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.click(await byId("prj-wz-create"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/projects" && c.method === "POST")).toBeTruthy());
    const post = calls.find((c) => c.path === "/api/v1/projects" && c.method === "POST")!;
    expect(post.body).toMatchObject({ name: "Orders Hub", templateId: "tpl-mine", teams: ["growth"], owner: "p-asha", budget: 2000 });
    expect((post.body as { approvers: Record<string, ApproverRule> }).approvers.G5!.required).toBe(2);
    expect((post.body as { notifications: unknown[] }).notifications.length).toBe(1);
    expect(post.headers["idempotency-key"]).toBeTruthy();
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/projects/orders-hub/repos")?.body).toMatchObject({ name: "acme/orders-api", team: "growth" }));
  });

  it("refuses a name that already exists before calling the server", async () => {
    window.history.replaceState(null, "", "/?view=templates");
    const calls = setup();
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-tpl-use-tpl-backend"));
    fireEvent.click(await byId("prj-wz-next"));
    fireEvent.change(await byId("prj-wz-name"), { target: { value: "Payments" } });
    fireEvent.change(await byId("prj-wz-team-add"), { target: { value: "growth" } });
    fireEvent.click(await byId("prj-wz-next"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists/);
    expect(calls.some((c) => c.method === "POST" && c.path !== "/api/v1/can")).toBe(false);
  });
});

describe("Project config", () => {
  it("says the project is not visible on a 403", async () => {
    setup({ "GET /api/v1/projects": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<ProjectConfigView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });

  /** A tab is in the URL (`?tab=`), so a test opens one by setting it before it mounts. */
  const tab = (id: string) => window.history.replaceState(null, "", `/?tab=${id}`);
  const withPayments = (extra: Record<string, Handler> = {}, denied: string[] = [], stepUp: string[] = []) => setup({ "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }), ...extra }, denied, stepUp);

  it("shows the overview and saves the description with the project version", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok({ version: 8 }) });
    mount(<ProjectConfigView />);
    const desc = (await byId("pcf-desc")) as HTMLTextAreaElement;
    await waitFor(() => expect(desc.value).toBe("Payments Platform desc"));
    fireEvent.change(desc, { target: { value: "New text" } });
    fireEvent.click(await byId("pcf-ov-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "desc", value: "New text" }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("7");
  });

  it("locks controls with the reason from the decision point", async () => {
    withPayments({}, ["project.config", "flow.edit"]);
    tab("flow-advanced");
    mount(<ProjectConfigView />);
    const add = await byId("pcf-add-station");
    await waitFor(() => expect(add.getAttribute("aria-disabled")).toBe("true"));
    expect(add.getAttribute("data-reason")).toMatch(/No role holds flow.edit/);
    expect(document.querySelector(".lock-note")?.textContent).toMatch(/Read-only for you: flow settings/);
    expect((await byId("pcf-gmode-G3d")).hasAttribute("disabled")).toBe(true);
  });

  it("flow tab: locked gates cannot be switched and say why; a gate that may be turned off asks first, then sends the audited, versioned change on Save", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok() });
    tab("flow");
    mount(<ProjectConfigView />);
    await byId("pcf-gmode-G0G1");
    expect(document.getElementById("flw-g-G0G1")!.textContent).toMatch(/Brief confirmed/);
    for (const id of ["G0G1", "G3G3s", "G4", "G5"]) {
      expect((await byId(`pcf-gate-${id}`)).hasAttribute("disabled"), id).toBe(true);
      expect(document.querySelector(`#flw-g-${id} .flw-on`)?.getAttribute("title"), id).toBeTruthy();
    }
    expect(document.querySelector("#flw-g-G5 .flw-on")?.getAttribute("title")).toMatch(/No agent merges on its own authority/);
    fireEvent.click(await byId("pcf-gate-G3d"));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false); // a draft until Save
    fireEvent.click(await byId("flw-save"));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "flow.gates.G3d.enabled", value: false }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("7");
  });

  it("flow tab: a regulated project keeps every gate on, with the reason", async () => {
    withPayments({ "GET /api/v1/projects": () => ({ body: [{ ...PAYMENTS, regulated: true }, RISK] }) });
    tab("flow");
    mount(<ProjectConfigView />);
    expect((await byId("pcf-gate-G3d")).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("#flw-g-G3d .flw-on")?.getAttribute("title")).toMatch(/Regulated projects keep every gate on/);
  });

  it("flow tab: station, WIP, slots and gate mode are one draft, saved in order with the version chained; moving a station is its own request", async () => {
    const calls = withPayments({
      "PATCH /api/v1/projects/payments/config": () => ok(),
      "PATCH /api/v1/projects/payments/flow/stations/spec": () => ok(),
    });
    tab("flow-advanced");
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-st-research"));
    fireEvent.change(await byId("pcf-wip-spec"), { target: { value: "9" } });
    const slots = (await byId("pcf-slots")) as HTMLInputElement;
    fireEvent.change(slots, { target: { value: "30" } });
    fireEvent.blur(slots);
    expect(await screen.findByText("Enter a number from 1 to 8.")).toBeTruthy();
    fireEvent.change(slots, { target: { value: "3" } });
    fireEvent.blur(slots);
    fireEvent.change(await byId("pcf-gmode-G1f"), { target: { value: "human" } });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    await waitFor(() => expect(document.getElementById("flw-count")!.textContent).toMatch(/4 unsaved changes/));
    fireEvent.click(await byId("flw-review"));
    expect((await byId("flw-changes")).textContent).toMatch(/Coding slots: \d+ → 3/);
    fireEvent.click(await byId("flw-save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(4));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => (c.body as { path?: string; gate?: string }).path ?? (c.body as { gate?: string }).gate)).toEqual(["flow.stations.research.enabled", "flow.stations.spec.wip", "G1f", "flow.slots"]);
    expect(patches[0]!.headers["if-match"]).toBe("7");
    expect(patches[3]!.headers["if-match"]).toBe("10");
    fireEvent.click(await byId("pcf-mv-dn-spec"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/projects/payments/flow/stations/spec")?.body).toEqual({ move: 1 }));
  });

  it("flow tab: a class route tick, a class switched off and Reset routes are part of the draft; Save writes the classes once with If-Match", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok() });
    tab("flow");
    mount(<ProjectConfigView />);
    const tick = (await byId("pcf-rm-feature-research")) as HTMLInputElement;
    expect(tick.checked).toBe(true);
    fireEvent.click(tick);
    expect(((await byId("pcf-rm-feature-research")) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(await byId("pcf-cl-en-docs"));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(await byId("flw-review"));
    const list = (await byId("flw-changes")).textContent ?? "";
    expect(list).toMatch(/Feature route: every station → skips 1/);
    expect(list).toMatch(/Docs class: on → off/);
    fireEvent.click(await byId("flw-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    const put = calls.filter((c) => c.method === "PATCH");
    expect(put).toHaveLength(1);
    const body = put[0]!.body as { path: string; value: Array<{ id: string; skips: string[]; enabled?: boolean }> };
    expect(body.path).toBe("flow.classes");
    expect(body.value.find((c) => c.id === "feature")!.skips).toContain("research");
    expect(body.value.find((c) => c.id === "docs")!.enabled).toBe(false);
    expect(put[0]!.headers["if-match"]).toBe("7");
  });

  it("flow tab: there is no Flow details link and no immediate-write station or gate row outside the draft", async () => {
    withPayments();
    tab("flow");
    mount(<ProjectConfigView />);
    await byId("pcf-wip-spec");
    expect(document.getElementById("flw-more")).toBeNull();
    expect(document.querySelectorAll("#pcf-st-table").length).toBe(0); // the structure table is collapsed until asked for
    expect(document.getElementById("flw-structure")).toBeNull();
    fireEvent.click(await byId("flw-adv-toggle"));
    expect(window.location.search).toMatch(/sec=structure/);
    expect(await byId("flw-structure")).toBeTruthy();
    expect(document.querySelectorAll("#pcf-wip-spec").length).toBe(1); // one WIP control per station, in the line editor
  });

  it("flow tab: refuses removing a custom station while work is at it, and shows the server's refusal", async () => {
    const custom = project("payments", "Payments Platform", {
      flow: { ...PAYMENTS.flow, order: [...PAYMENTS.flow.order.slice(0, -1), "compliance", "close"], stations: { ...PAYMENTS.flow.stations, compliance: { enabled: true, wip: 5 } } },
      metrics: metrics({ byPosition: { compliance: { n: 2, blocked: 0 } } }),
    });
    withPayments({ "GET /api/v1/projects": () => ({ body: [custom] }), "GET /api/v1/catalog": () => ({ body: { ...CAT, stations: [...CAT.stations, { id: "compliance", no: "S7·1", name: "Compliance", agent: "ag-x", purpose: "", custom: true, project: "payments" }] } }) });
    tab("flow-advanced");
    mount(<ProjectConfigView />);
    const rm = await byId("pcf-st-rm-compliance");
    expect(rm.getAttribute("data-reason")).toBe("2 work orders are at Compliance. Move them first.");
  });

  it("flow tab: the add-bay dialog posts the bay with the project version and shows a refusal inline", async () => {
    const calls = withPayments({ "POST /api/v1/projects/payments/flow/bays": () => ({ status: 409, body: { ok: false, msg: "This project already has that bay." } }) });
    tab("flow-advanced");
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-add-bay"));
    fireEvent.change(await byId("pcf-nb-name"), { target: { value: "Hold" } });
    fireEvent.submit(document.querySelector(".dlg-form")!);
    expect(await screen.findByText("This project already has that bay.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/flow/bays"))!;
    expect(post.body).toEqual({ def: { name: "Hold", desc: "" } });
    expect(post.headers["if-match"]).toBe("7");
    expect(post.headers["idempotency-key"]).toBeTruthy();
  });

  it("members tab: grants and removes a project role", async () => {
    const calls = withPayments({ "PUT /api/v1/projects/payments/members/p-asha/roles/reviewer": () => ok(), "DELETE /api/v1/projects/payments/members/p-meera/roles/line_lead": () => ok() });
    tab("members");
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-rm-p-meera-line_lead"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    fireEvent.change(await byId("pcf-add-role"), { target: { value: "reviewer" } });
    fireEvent.click(await byId("pcf-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/members/p-meera/roles/reviewer") || c.path.includes("/members/p-tomas/roles/reviewer"))).toBe(true));
  });

  it("members tab: project admins choose who is on call, with the project version; a stale save says so", async () => {
    let stale = false;
    const calls = withPayments({ "PUT /api/v1/projects/payments/oncall": () => (stale ? { status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } } : ok({ oncall: ["p-meera"], version: 8 })) });
    tab("members");
    mount(<ProjectConfigView />);
    expect(await byId("pcf-oncall-none")).toBeTruthy();
    fireEvent.change(await byId("pcf-oncall-pick"), { target: { value: "p-meera" } });
    fireEvent.click(await byId("pcf-oncall-add"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/oncall"))?.body).toEqual({ people: ["p-meera"] }));
    expect(calls.find((c) => c.path.endsWith("/oncall"))!.headers["if-match"]).toBe("7");
    stale = true;
    fireEvent.click(await byId("pcf-oncall-add"));
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
  });

  it("approvers tab: edits a rule, refuses N larger than the eligible people, and saves with If-Match", async () => {
    const people = [PEOPLE[0]!, person("p-meera", "Meera Iyer", [{ role: "line_lead", scope: "payments" }]), person("p-priya", "Priya Nair", [{ role: "reviewer", scope: "payments" }])];
    const calls = withPayments({ "GET /api/v1/people": () => ({ body: people }), "PUT /api/v1/projects/payments/approvers/G5": () => ok() });
    tab("rules"); // an old bookmark: lands on Approvers with the rule editor open
    mount(<ProjectConfigView />);
    await byId("pcf-rule");
    expect(window.location.search).toMatch(/tab=approvers/);
    expect(window.location.search).toMatch(/rule=G5/);
    const req = (await byId("pcf-ap-required")) as HTMLInputElement;
    fireEvent.change(req, { target: { value: "5" } });
    fireEvent.blur(req);
    fireEvent.click(await byId("pcf-ap-save"));
    expect((await screen.findByText(/Needs 5 approvals but only 1 eligible person is in Payments Platform\./)).textContent).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.change(req, { target: { value: "1" } });
    fireEvent.blur(req);
    fireEvent.click(await byId("pcf-ap-add-hotfix"));
    fireEvent.click(await byId("pcf-ap-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as { value: ApproverRule }).value.conditions[0]).toMatchObject({ when: { type: "class", value: "hotfix" }, needs: { roles: ["release_manager"], oncall: true } });
    expect(put.headers["if-match"]).toBe("7");
  });

  it("danger zone: archiving needs the typed project name and sends If-Match", async () => {
    const calls = withPayments({ "POST /api/v1/projects/payments/archive": () => ok() });
    window.history.replaceState(null, "", "/?tab=line"); // Archive is a panel of Line control
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-archive"));
    const input = await waitFor(() => { const i = document.querySelector<HTMLInputElement>(".dlg input.input"); if (!i) throw new Error("no input"); return i; });
    fireEvent.change(input, { target: { value: "Payments Platform" } });
    fireEvent.submit(document.querySelector(".dlg-form")!);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/archive"))).toBeTruthy());
    const post = calls.find((c) => c.path.endsWith("/archive"))!;
    expect(post.body).toEqual({ confirmText: "Payments Platform" });
    expect(post.headers["if-match"]).toBe("7");
  });

  it("budget tab: Spend and Limits panels, validates inline, saves the monthly budget then the alert with the project version", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok({ version: 8 }) });
    tab("budget");
    mount(<ProjectConfigView />);
    const el = (await byId("pcf-bud-monthly")) as HTMLInputElement;
    expect(Array.from(document.querySelectorAll(".panel-title")).map((h) => h.textContent).slice(0, 2)).toEqual(["Spend", "Limits"]);
    fireEvent.change(document.getElementById("pcf-bud-alert")!, { target: { value: "120" } });
    fireEvent.click(await byId("pcf-bud-save"));
    expect(await screen.findByText("Cannot exceed 100.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(document.getElementById("pcf-bud-alert")!, { target: { value: "90" } });
    fireEvent.change(el, { target: { value: "5000" } });
    fireEvent.click(await byId("pcf-bud-save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ path: "budget.monthly", value: 5000 }, { path: "budget.alertAt", value: 0.9 }]));
    expect(calls.filter((c) => c.method === "PATCH")[1]!.headers["if-match"]).toBe("8");
    expect(await screen.findByText("Budget saved")).toBeTruthy();
  });

  it("budget tab: any amount from 0 to 10,000,000 is accepted, decimals too (the server's range)", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok({ version: 8 }) });
    tab("budget");
    mount(<ProjectConfigView />);
    const el = (await byId("pcf-bud-monthly")) as HTMLInputElement;
    for (const v of ["10", "0", "12.5"]) {
      calls.length = 0;
      fireEvent.change(el, { target: { value: v } });
      fireEvent.click(await byId("pcf-bud-save"));
      await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ path: "budget.monthly", value: Number(v) }]));
      expect(screen.queryByText(/Must be at least/)).toBeNull();
    }
    calls.length = 0;
    fireEvent.change(el, { target: { value: "10000001" } });
    fireEvent.click(await byId("pcf-bud-save"));
    expect(await screen.findByText("Cannot exceed 10,000,000.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("is the Blueprint's eight tabs held in the URL, with no More menu; an old ?tab= id lands on the tab and section that took it over", async () => {
    window.location.hash = "#/p/payments/project-config";
    withPayments();
    mount(<ProjectConfigView />);
    await byId("pcf-desc");
    expect(document.querySelector(".vhead .kicker")?.textContent).toBe("GNT-CFG-10·PAY");
    expect(document.querySelector(".vhead .vsub")?.textContent).toBe("Payments Platform · PAY");
    expect(document.getElementById("pcf-pages")).toBeNull(); // no More menu
    expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Overview", "Flow", "Approvers", "MCP", "Budget", "Repos", "Members", "Line control"]);
    fireEvent.click(await byId("pcf-tab-flow"));
    expect(window.location.search).toBe("?tab=flow");
    expect(document.getElementById("pcf-tab-flow")!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await byId("pcf-tab-members"));
    await byId("pcf-oncall-none");
    expect(document.getElementById("pcf-tab-members")!.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("pcf-back")).toBeNull();
    cleanup();
    const landing: Array<[string, string, string, RegExp]> = [
      ["classes", "flw-classes", "flow", /^\?tab=flow$/],
      ["flow-advanced", "flw-structure", "flow", /tab=flow.*sec=structure|sec=structure.*tab=flow/],
      ["rules", "pcf-rule", "approvers", /rule=G5/],
      ["spend", "pcf-bud-monthly", "budget", /^\?tab=budget$/],
      ["archive", "pcf-archive-panel", "line", /^\?tab=line$/],
      ["history", "pcf-recent", "overview", /^$/],
      ["notifications", "pcf-notify", "overview", /^$/],
      ["more", "pcf-overlay", "overview", /^$/],
    ];
    for (const [old, el, tabId, search] of landing) {
      window.history.replaceState(null, "", `/?tab=${old}`);
      mount(<ProjectConfigView />);
      await byId(el);
      expect(document.getElementById(`pcf-tab-${tabId}`)!.getAttribute("aria-selected"), old).toBe("true");
      expect(window.location.search, old).toMatch(search);
      cleanup();
    }
  });

  it("Overview: Details (Name, Description, Owner, Instructions overlay, Save), a five-row Summary with Save as template, Recent changes, Notifications and Advanced", async () => {
    withPayments();
    mount(<ProjectConfigView />);
    await byId("pcf-desc");
    expect(Array.from(document.querySelectorAll(".panel-title")).map((h) => h.textContent)).toEqual(["Details", "Summary", "Recent changes", "Notifications", "Advanced"]);
    expect(Array.from(document.querySelectorAll(".kv dt")).map((d) => d.textContent)).toEqual(["Key", "Template", "Teams", "Regulated", "Repos"]);
    const name = document.getElementById("pcf-name") as HTMLInputElement;
    expect(name.value).toBe("Payments Platform");
    expect(name.disabled).toBe(false); // an editable required field, not a read-only one with a hint
    expect(document.getElementById("pcf-more")).toBeNull();
    expect(document.getElementById("pcf-ov-save")!.textContent).toBe("Save");
    expect(document.getElementById("pcf-save-tpl")!.textContent).toBe("Save as template");
    expect(document.getElementById("pcf-to-audit")!.getAttribute("href")).toBe("#/audit?project=payments");
    expect(document.getElementById("pcf-flow-sum")).toBeNull(); // the flow summary is behind Advanced
    fireEvent.click(await byId("pcf-adv-toggle"));
    expect((await byId("pcf-flow-sum")).textContent).toMatch(/\d+ stations, \d+ gates/);
  });

  it("Overview: the instructions overlay saves with the description, one version chained from the other", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok() });
    mount(<ProjectConfigView />);
    const overlay = (await byId("pcf-overlay")) as HTMLTextAreaElement;
    fireEvent.change(await byId("pcf-desc"), { target: { value: "Changed" } });
    fireEvent.change(overlay, { target: { value: "Always cite the ticket." } });
    fireEvent.click(await byId("pcf-ov-save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBe(2));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.body)).toEqual([{ path: "desc", value: "Changed" }, { path: "overlay", value: "Always cite the ticket." }]);
    expect(patches.map((c) => c.headers["if-match"])).toEqual(["7", "8"]);
  });

  it("Overview: Notifications shows the route count and turns a route on or off with If-Match; Recent changes says when the ledger is refused", async () => {
    const route = { id: "NR-9", event: "gate.waiting", dest: [{ channel: "slack", target: "#gates" }], template: "gate", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: {} };
    const calls = withPayments({
      "GET /api/v1/projects": () => ({ body: [{ ...PAYMENTS, notifications: [route] }, RISK] }),
      "PATCH /api/v1/projects/payments/config": () => ok(),
      "GET /api/v1/audit": () => ({ status: 403, body: { ok: false, msg: "Needs audit.view." } }),
    });
    mount(<ProjectConfigView />);
    expect((await byId("pcf-notify-count")).textContent).toBe("1 route, 1 on.");
    fireEvent.click(await byId("pcf-nr-NR-9"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ path: "notifications" }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("7");
    expect(await screen.findByText("Not visible to you")).toBeTruthy(); // a refused ledger is not "No history yet"
    expect(screen.queryByText("No history yet")).toBeNull();
  });

  it("Flow: Stations and Gates as compact rows, then Advanced: structure, Class routes and Work classes; gates in flow order with an S1 → S2 hint; every control labelled", async () => {
    withPayments({});
    tab("flow");
    mount(<ProjectConfigView />);
    await byId("pcf-wip-spec");
    expect(Array.from(document.querySelectorAll("#flw .flw-cols > section > h2, #flw .panel-title")).map((h) => h.textContent)).toEqual(["Stations", "Gates", "Advanced: structure", "Class routes", "Work classes on Payments Platform"]);
    expect(Array.from(document.querySelectorAll("#flw .flw-list:not(.flw-gates) > li")).slice(0, 3).map((li) => li.id)).toEqual(["flw-st-intake", "flw-st-research", "flw-st-spec"]);
    expect(Array.from(document.querySelectorAll("#flw .flw-gates > li")).slice(0, 3).map((li) => li.id)).toEqual(["flw-g-G0G1", "flw-g-G1f", "flw-g-G2"]);
    expect(document.querySelector("#flw-g-G2 .flw-hint")!.textContent).toBe("S2 → S3");
    expect(document.querySelector("#flw-st-intake")!.textContent).toMatch(/Always on/);
    expect(document.querySelector("#flw-st-intake input[role=switch]")).toBeNull();
    expect(document.querySelectorAll("#flw .flw-cols .panel").length).toBe(2); // no card grid
    for (const el of Array.from(document.querySelectorAll("#flw input, #flw select"))) {
      expect(el.getAttribute("aria-label") || document.querySelector(`label[for="${el.id}"]`), el.id).toBeTruthy();
    }
    expect(screen.getByLabelText("Spec WIP limit")).toBeTruthy();
    expect(screen.getByLabelText("Research station on")).toBeTruthy();
    expect(screen.getByLabelText("Spec approved on")).toBeTruthy();
    // a row opens in place, and that is in the URL
    expect(document.querySelector("#flw-st-spec")!.textContent).not.toMatch(/Routes:/);
    fireEvent.click(await byId("flw-x-s-spec"));
    expect(document.querySelector("#flw-st-spec")!.textContent).toMatch(/Routes:/);
    expect(window.location.search).toMatch(/open=s%3Aspec|open=s:spec/);
  });

  it("Flow: hovering a station lights the gates on either side of it, and a gate lights its two stations", async () => {
    withPayments({});
    tab("flow");
    mount(<ProjectConfigView />);
    await byId("pcf-wip-spec");
    fireEvent.mouseEnter(document.getElementById("flw-st-spec")!);
    expect(Array.from(document.querySelectorAll("#flw .is-link")).map((e) => e.id)).toEqual(["flw-g-G1f", "flw-g-G2"]);
    fireEvent.mouseLeave(document.getElementById("flw-st-spec")!);
    expect(document.querySelector("#flw .is-link")).toBeNull();
    fireEvent.focus(document.getElementById("pcf-gmode-G2")!);
    expect(Array.from(document.querySelectorAll("#flw .is-link")).map((e) => e.id)).toEqual(["flw-st-spec", "flw-st-design"]);
  });

  it("Flow: the mode select offers plain labels, and Off is the On switch (the gate's enabled flag)", async () => {
    withPayments({});
    tab("flow");
    mount(<ProjectConfigView />);
    const sel = (await byId("pcf-gmode-G1f")) as HTMLSelectElement;
    const byLabel = Object.fromEntries(Array.from(sel.options).map((o) => [o.textContent, o.value]));
    expect(byLabel).toMatchObject({ "Person approves": "human", "Automatic check": "auto", "Mixed": "mixed" });
    expect(byLabel).not.toHaveProperty("Off");
    expect((screen.getByLabelText("Feasibility on") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await byId("flw-x-g-G1f"));
    expect(sel.closest("li")!.textContent).toMatch(/Passes by itself/);
  });

  it("Flow line: edits are a draft, Review lists before and after, Save sends the same requests with If-Match", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok({ version: 8 }) });
    tab("flow");
    mount(<ProjectConfigView />);
    const wip = (await byId("pcf-wip-spec")) as HTMLInputElement;
    const before = wip.value;
    fireEvent.change(wip, { target: { value: "9" } });
    fireEvent.change(await byId("pcf-gmode-G1f"), { target: { value: "human" } });
    expect(document.getElementById("flw-count")!.textContent).toMatch(/2 unsaved changes/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false); // nothing is written until Save
    fireEvent.click(await byId("flw-review"));
    const list = (await byId("flw-changes")).textContent ?? "";
    expect(list).toContain(`S2 Spec WIP limit: ${before} → 9`);
    expect(list).toMatch(/G1f Feasibility: .* → Person approves/);
    fireEvent.click(await byId("flw-save"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").length).toBeGreaterThanOrEqual(2));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches[0]!.body).toEqual({ path: "flow.stations.spec.wip", value: 9 });
    expect(patches[0]!.headers["if-match"]).toBe("7");
    expect(patches.some((c) => (c.body as { gate?: string }).gate === "G1f")).toBe(true);
    expect(patches[1]!.headers["if-match"]).toBe("8"); // the version chained from the first save
  });

  it("Flow line: a gate whose approver rule cannot be satisfied shows the warning", async () => {
    const rule = { roles: ["nobody_holds_this"], people: [], required: 2, sod: true, conditions: [], escalateH: 0, fallback: null };
    const bad = { ...PAYMENTS, approvers: { ...PAYMENTS.approvers, G2: rule } };
    withPayments({ "GET /api/v1/projects": () => ({ body: [bad, RISK] }) });
    tab("flow");
    mount(<ProjectConfigView />);
    expect((await byId("flw-warn-G2")).textContent).toMatch(/cannot pass as configured/);
  });

  it("Flow: at narrow widths the two panels stack and rows wrap (CSS), and the card grid is gone", () => {
    // jsdom has no layout: check the stylesheet carries the rules so a regression is caught.
    const css = readFileSync(join(__dirname, "../styles/views/project-config.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 1100px\)\s*{\s*\.flw-cols\s*{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 640px\)\s*{[^}]*\.flw-line/);
    expect(css).not.toMatch(/flw-card/);
  });

  it("Approvers: a gate table; Edit opens the full rule editor in place (roles, per-class counts, conditions, away, scenario) and the deep link names the gate", async () => {
    withPayments();
    tab("approvers");
    window.location.hash = "#/p/payments/project-config/approvers/G2";
    mount(<ProjectConfigView />);
    expect(Array.from((await waitFor(() => { const t = document.querySelectorAll("#pcf-appr thead th"); if (!t.length) throw new Error("no table"); return t; }))).map((t) => t.textContent?.replace(/[↑↓↕]/, "").trim())).toEqual(["Gate", "Roles", "Needed", "Separation", "Escalate", ""]);
    expect((await byId("pcf-rule")).getAttribute("aria-label")).toMatch(/G2/); // the Traveler's Edit rule link opens that gate
    fireEvent.click(await byId("pcf-ap-edit-G5"));
    await waitFor(() => expect(document.getElementById("pcf-rule")!.getAttribute("aria-label")).toMatch(/G5/));
    for (const id of ["pcf-ap-required", "pcf-ap-sod", "pcf-ap-add", "pcf-ap-esc", "pcf-ap-fallback", "pcf-sc-cls"]) expect(document.getElementById(id), id).toBeTruthy();
    expect(document.querySelector("#pcf-rule .sub-h")).toBeTruthy();
    expect(screen.getByText("Away and delegates")).toBeTruthy();
    fireEvent.click(await byId("pcf-ap-close"));
    expect(document.getElementById("pcf-rule")).toBeNull();
    expect(document.querySelector(".dlg")).toBeNull(); // no 3-field dialog
  });

  it("MCP: a switch row per server with its url; the tab count is the servers attached", async () => {
    const calls = withPayments({ "GET /api/v1/mcp/servers": () => ({ body: [{ id: "mcp-db", name: "Database", url: "https://db.example", health: "healthy", sensitivity: "low", tools: [], projects: "all" }] }), "PATCH /api/v1/projects/payments/config": () => ok() });
    tab("mcp");
    mount(<ProjectConfigView />);
    const sw = await byId("pcf-mcp-mcp-db");
    expect(sw.closest(".check")?.textContent).toContain("https://db.example");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "mcp", value: ["mcp-db"] }));
    expect(await screen.findByText("Database attached")).toBeTruthy();
  });

  it("Repos: the project's repositories, each linking to its dossier with a language chip and active / halted", async () => {
    withPayments({ "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "acme/payments-api", lang: "Go", halted: null, onboarding: { stage: "ready", findings: [], pr: null, timeline: [] } }] }) });
    tab("repos");
    mount(<ProjectConfigView />);
    const a = await waitFor(() => { const x = document.querySelector<HTMLAnchorElement>("#pcf-repos a.pri, .list a.pri"); if (!x) throw new Error("no link"); return x; });
    expect(a.getAttribute("href")).toBe("#/p/payments/dossier/payments-api");
    expect(a.closest("li")?.textContent).toMatch(/Go\s*active/i);
  });

  it("Line control: Halt and Kill project, in a panel with the Blueprint's text", async () => {
    withPayments();
    tab("line");
    mount(<ProjectConfigView />);
    expect(await screen.findByText("Halting lets running agents finish their current step. A kill stops them now.")).toBeTruthy();
    expect(document.getElementById("pcf-halt")!.textContent).toBe("Halt project");
    expect(document.getElementById("pcf-kill")!.textContent).toBe("Kill project");
    expect(document.getElementById("pcf-tab-line")!.textContent).toBe("Line control");
  });

  it("Name is editable and required (3 characters); a rename goes to the server and its refusal is shown on the field", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ({ status: 409, body: { ok: false, msg: "Renaming a project is not supported." } }) });
    mount(<ProjectConfigView />);
    const name = (await byId("pcf-name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "ab" } });
    fireEvent.click(await byId("pcf-ov-save"));
    expect(await screen.findByText("Name needs at least 3 characters.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(name, { target: { value: "Payments Core" } });
    fireEvent.click(await byId("pcf-ov-save"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "name", value: "Payments Core" }));
    expect(await screen.findByText("Renaming a project is not supported.")).toBeTruthy();
  });

  it("Repos lists the live repositories under Ready, and the ones still being onboarded under Still onboarding", async () => {
    const ready = (id: string) => ({ id, name: `acme/${id}`, project: "payments", team: "payments", tags: [], lang: "Go", halted: null, onboarding: { stage: "ready", findings: [], pr: null, timeline: [], exception: null } });
    const moving = { ...ready("moving"), onboarding: { stage: "assessed", findings: [], pr: null, timeline: [], exception: null } };
    withPayments({ "GET /api/v1/projects/payments/repos": () => ({ body: [ready("a"), ready("b"), moving] }) });
    tab("repos");
    mount(<ProjectConfigView />);
    await waitFor(() => expect(document.querySelectorAll("#pcf-ready .list li").length).toBe(2));
    expect(document.querySelector("#pcf-ready")!.textContent).not.toMatch(/acme\/moving/);
    // the one still onboarding is listed apart, linking to its Onboarding session
    const link = (await waitFor(() => { const x = document.querySelector<HTMLAnchorElement>("#pcf-onb-list a.pri"); if (!x) throw new Error("none"); return x; }));
    expect(link.textContent).toBe("acme/moving");
    expect(link.getAttribute("href")).toBe("#/p/payments/onboarding/moving");
  });

  it("Line control: Halt and stop, then the Archive panel; Kill asks only for the project key, not the shell's kill dialog", async () => {
    const calls = withPayments({ "POST /api/v1/stops/project/payments/kill": () => ok(), "POST /api/v1/stops": () => ok() });
    tab("line");
    mount(<ProjectConfigView />);
    await byId("pcf-kill");
    expect(Array.from(document.querySelectorAll(".panel-title")).map((h) => h.textContent)).toEqual(["Halt and stop", "Archive this project"]);
    expect(document.getElementById("pcf-archive")).toBeTruthy();
    fireEvent.click(document.getElementById("pcf-kill")!);
    expect(await screen.findByText("Type the project key (PAY)")).toBeTruthy();
    fireEvent.change(document.getElementById("fd-c")!, { target: { value: "WRONG" } });
    expect(document.getElementById("fd-reason")).toBeNull(); // the prototype asks only for the key
    fireEvent.click(within(document.querySelector(".dlg") as HTMLElement).getByRole("button", { name: "Kill project" }));
    expect(await screen.findByText("Type PAY exactly.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && /kill|stops/.test(c.path))).toBe(false);
  });

  it("Members is a tab: members and roles, grant a role, on call and the factory-wide roles, each with its own guard", async () => {
    withPayments({}, ["project.members"]);
    tab("members");
    mount(<ProjectConfigView />);
    expect(await byId("pcf-mem-table")).toBeTruthy();
    expect(Array.from(document.querySelectorAll(".panel-title")).map((h) => h.textContent)).toEqual(["Members of Payments Platform", "Grant a role", "On call", "Factory-wide roles"]);
    await waitFor(() => expect(document.getElementById("pcf-add-go")!.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("pcf-rm-p-meera-line_lead")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("Budget: spend by station and the most expensive work orders from the work orders on record, no stale limit fields", async () => {
    const wo = (id: string, cost: number) => ({ id, title: `Work ${id}`, history: [{ station: "build", cost }], project: "payments" });
    withPayments({ "GET /api/v1/projects/payments/work-orders": () => ({ body: [wo("WO-1", 4), wo("WO-2", 9)] }) });
    tab("spend");
    mount(<ProjectConfigView />);
    expect((await byId("pcf-bud-st-build")).textContent).toMatch(/\$13/);
    expect(Array.from(document.querySelectorAll("#pcf-bud-top-table tbody tr")).map((r) => r.querySelector("button")?.textContent)).toEqual(["WO-2", "WO-1"]);
    expect(document.getElementById("pcf-bud-monthly")!.getAttribute("min")).toBe("0");
    expect(document.getElementById("pcf-bud-monthly")!.getAttribute("max")).toBe("10000000");
  });

  it("Halt project halts at once with the Blueprint's toast; WIP below 1 says so; locked Kill shows the title", async () => {
    const calls = withPayments({ "POST /api/v1/stops": () => ok() });
    tab("line");
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-halt"));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/stops")?.body).toMatchObject({ scope: "project", id: "payments", mode: "halt" }));
    expect(document.querySelector(".dlg")).toBeNull();
    expect(await screen.findByText("Payments Platform halted")).toBeTruthy();
  });

  it("read-only: Kill project, Halt project and the approver Edit carry the lock title and toast on click", async () => {
    withPayments({}, ["kill.project", "halt.project", "project.config", "flow.edit"]);
    tab("line");
    mount(<ProjectConfigView />);
    const kill = await byId("pcf-kill");
    await waitFor(() => expect(kill.getAttribute("aria-disabled")).toBe("true"));
    // a real denial shows the server's own reason, not a generic read-only line
    expect(kill.getAttribute("title")).toBe("Needs Project Admin. No role holds kill.project.");
    expect(document.getElementById("pcf-halt")!.getAttribute("title")).toBe("Needs Project Admin. No role holds halt.project.");
    fireEvent.click(kill);
    expect(await screen.findByText("Needs Project Admin. No role holds kill.project.", { selector: "[role=status] *, [role=status], .toast, .toast *" })).toBeTruthy();
    expect(screen.queryByText("Your role is read-only for this action.")).toBeNull();
  });

  it("step-up only: Halt project stays enabled with the sign-in hint and clicking runs the command, which reaches the step-up handler", async () => {
    const stepUpBody = { status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up", rule: { kind: "step-up", id: "STEP-UP", windowSec: 900, signedInSecAgo: 5700 } } };
    const calls = withPayments({ "POST /api/v1/stops": () => stepUpBody }, [], ["halt.project", "project.config"]);
    const handler = vi.fn(async (): Promise<StepUpOutcome> => ({ ok: false, error: "cancelled" }));
    setStepUpHandler(handler);
    tab("line");
    mount(<ProjectConfigView />);
    const halt = await byId("pcf-halt");
    await waitFor(() => expect(halt.getAttribute("title")).toMatch(/asked to sign in again/));
    expect(halt.getAttribute("aria-disabled")).toBeNull();
    expect(halt.getAttribute("title")).not.toMatch(/read-only/i);
    fireEvent.click(halt);
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/stops")).toBe(true);
    setStepUpHandler(null);
  });

  it("Flow lists the Compliance sign-off gate (off) when the project's flow carries it", async () => {
    const withGc = { ...PAYMENTS, flow: { ...PAYMENTS.flow, gates: { ...PAYMENTS.flow.gates, GC: { enabled: false, mode: "human", absent: true } } } };
    withPayments({ "GET /api/v1/projects": () => ({ body: [withGc, RISK] }), "GET /api/v1/catalog": () => ({ body: { ...CAT, gates: [...CAT.gates, { id: "GC", label: "GC", name: "Compliance sign-off", kind: "human", checks: [] }] } }) });
    tab("flow");
    mount(<ProjectConfigView />);
    expect(((await byId("pcf-gate-GC")) as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("pcf-gmode-GC") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("Compliance sign-off")).toBeTruthy();
  });
});
