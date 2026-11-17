import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG, type ApproverRule } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
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

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
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
        return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Project Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
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
  try { localStorage.clear(); } catch { /* ignore */ }
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

  it("lists the projects with their health, hides archived ones, and filters", async () => {
    setup();
    mount(<ProjectsView />);
    expect(await screen.findByText("Payments Platform")).toBeTruthy();
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(screen.queryByText("Legacy Checkout")).toBeNull();
    fireEvent.click(await byId("prj-pf-arch"));
    expect(await screen.findByText("Legacy Checkout")).toBeTruthy();
    expect(within(document.getElementById("prj-pf") as HTMLElement).getByText("Unarchive")).toBeTruthy();
    fireEvent.change(document.getElementById("prj-pf-health")!, { target: { value: "attention" } });
    await waitFor(() => expect(screen.queryByText("Payments Platform")).toBeNull());
    expect(screen.getByText("Risk and Compliance")).toBeTruthy();
  });

  it("shows the header counts and disables New project with the reason when the right is missing", async () => {
    setup({}, ["project.create"]);
    mount(<ProjectsView />);
    const btn = await byId("prj-new");
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(btn.getAttribute("data-reason")).toMatch(/Needs Project Admin. No role holds project.create/);
    expect(screen.getByText("Portfolio").closest("button")?.textContent).toContain("3");
  });

  it("saves a view to the server, and updates and deletes it with its version", async () => {
    const calls = setup({
      "POST /api/v1/saved-views": () => ok({ view: { id: "v-2", name: "Spend", screen: "portfolio", s: {}, version: 1 } }),
      "PATCH /api/v1/saved-views/v-1": () => ok(),
      "DELETE /api/v1/saved-views/v-1": () => ok(),
    });
    mount(<ProjectsView />);
    await screen.findByText("Payments Platform");
    fireEvent.click(await byId("prj-pf-view-v-1"));
    await waitFor(() => expect(document.getElementById("prj-pf-view-v-1")?.getAttribute("aria-selected")).toBe("true"));
    // the saved view's grouping is applied
    expect(document.querySelector(".pf-group-h")).toBeTruthy();
    fireEvent.change(document.getElementById("prj-pf-sort")!, { target: { value: "spend" } });
    fireEvent.click(await byId("prj-pf-vupd"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("3"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ s: { sort: "spend", group: "team" } });
    fireEvent.click(await byId("prj-pf-vdel"));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.headers["if-match"]).toBe("3"));
    fireEvent.click(await byId("prj-pf-vsave"));
    fireEvent.change(await byId("pf-view-name"), { target: { value: "Spend" } });
    fireEvent.click(await byId("pf-view-ok"));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/saved-views")?.body).toMatchObject({ name: "Spend", screen: "portfolio" }));
  });

  it("offers Rename and Delete only for a saved view, not a built-in one", async () => {
    setup();
    mount(<ProjectsView />);
    await screen.findByText("Payments Platform");
    expect(document.getElementById("prj-pf-vdel")).toBeNull();
    expect(document.getElementById("prj-pf-vren")).toBeNull();
    fireEvent.click(await byId("prj-pf-view-v-1"));
    expect(await byId("prj-pf-vdel")).toBeTruthy();
    expect(await byId("prj-pf-vren")).toBeTruthy();
  });
});

describe("Projects: templates and wizard", () => {
  it("lists templates; built-in ones are read-only, a custom one opens the editor", async () => {
    const calls = setup({ "PATCH /api/v1/templates/tpl-mine": () => ok({ version: 5 }) });
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-tab-templates"));
    expect((await byId("prj-tpl-edit-tpl-backend")).getAttribute("data-reason")).toMatch(/Built-in templates are read-only/);
    fireEvent.click(await byId("prj-tpl-edit-tpl-mine"));
    fireEvent.change(await byId("prj-te-name"), { target: { value: "Renamed template" } });
    fireEvent.submit(document.querySelector(".dlg-form")!);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ name: "Renamed template", stationsOff: ["design"], slots: 1 }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("4");
  });

  it("walks the wizard and creates the project with the chosen presets, then connects its repos", async () => {
    const calls = setup({
      "POST /api/v1/projects": () => ok({ project: { id: "orders-hub", name: "Orders Hub" }, custom: { done: [], failed: [] } }),
      "POST /api/v1/projects/orders-hub/repos": () => ok(),
    });
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-new"));
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
    const calls = setup();
    mount(<ProjectsView />);
    fireEvent.click(await byId("prj-new"));
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

  const withPayments = (extra: Record<string, Handler> = {}, denied: string[] = []) => setup({ "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }), ...extra }, denied);

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
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
    const add = await byId("pcf-add-station");
    await waitFor(() => expect(add.getAttribute("aria-disabled")).toBe("true"));
    expect(add.getAttribute("data-reason")).toMatch(/No role holds flow.edit/);
    expect(document.querySelector(".lock-note")?.textContent).toMatch(/Read-only for you: flow settings/);
    expect((await byId("pcf-gmode-G3d")).hasAttribute("disabled")).toBe(true);
  });

  it("flow tab: gates read by name with the code beside, their kind and approvals; locked gates say why and cannot be switched", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok() });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
    const row = (await byId("pcf-gmode-G0G1")).closest("tr") as HTMLElement;
    expect(row.querySelector("th")?.textContent).toMatch(/Brief confirmed\s*G0\+G1/);
    expect(row.textContent).toMatch(/person · 1 approval: the submitter, or Line Lead/);
    const auto = (await byId("pcf-gmode-G4")).closest("tr") as HTMLElement;
    expect(auto.textContent).toMatch(/automatic · No approvals/);
    for (const id of ["G0G1", "G3G3s", "G4", "G5"]) {
      expect(document.getElementById(`pcf-gate-${id}`), id).toBeNull();
      expect(document.getElementById(`pcf-gate-lock-${id}`)?.textContent, id).toMatch(/always on/);
    }
    expect(document.getElementById("pcf-gate-lock-G5")?.getAttribute("title")).toMatch(/No agent merges on its own authority/);
    // a gate that may be turned off asks first, then sends the audited, versioned change
    fireEvent.click(await byId("pcf-gate-G3d"));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "flow.gates.G3d.enabled", value: false }));
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toBe("7");
  });

  it("flow tab: a regulated project keeps every gate on, with the reason", async () => {
    withPayments({ "GET /api/v1/projects": () => ({ body: [{ ...PAYMENTS, regulated: true }, RISK] }) });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
    await byId("pcf-gmode-G3d");
    expect(document.getElementById("pcf-gate-G3d")).toBeNull();
    expect(document.getElementById("pcf-gate-lock-G3d")?.getAttribute("title")).toMatch(/Regulated projects keep every gate on/);
  });

  it("flow tab: toggles a station, sets WIP and slots, changes a gate mode, and moves a station", async () => {
    const calls = withPayments({
      "PATCH /api/v1/projects/payments/config": () => ok(),
      "PATCH /api/v1/projects/payments/flow/stations/spec": () => ok(),
    });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
    fireEvent.click(await byId("pcf-st-research"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "flow.stations.research.enabled", value: false }));
    const wip = (await byId("pcf-wip-spec")) as HTMLInputElement;
    fireEvent.change(wip, { target: { value: "9" } });
    fireEvent.blur(wip);
    await waitFor(() => expect(calls.some((c) => (c.body as { path?: string })?.path === "flow.stations.spec.wip")).toBe(true));
    const slots = (await byId("pcf-slots")) as HTMLInputElement;
    fireEvent.change(slots, { target: { value: "30" } });
    fireEvent.blur(slots);
    expect(await screen.findByText("Enter a number from 1 to 8.")).toBeTruthy();
    fireEvent.change(await byId("pcf-gmode-G3d"), { target: { value: "mixed" } });
    await waitFor(() => expect(calls.some((c) => (c.body as { gate?: string })?.gate === "G3d")).toBe(true));
    fireEvent.click(await byId("pcf-mv-dn-spec"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/projects/payments/flow/stations/spec")?.body).toEqual({ move: 1 }));
  });

  it("flow tab: refuses removing a custom station while work is at it, and shows the server's refusal", async () => {
    const custom = project("payments", "Payments Platform", {
      flow: { ...PAYMENTS.flow, order: [...PAYMENTS.flow.order.slice(0, -1), "compliance", "close"], stations: { ...PAYMENTS.flow.stations, compliance: { enabled: true, wip: 5 } } },
      metrics: metrics({ byPosition: { compliance: { n: 2, blocked: 0 } } }),
    });
    withPayments({ "GET /api/v1/projects": () => ({ body: [custom] }), "GET /api/v1/catalog": () => ({ body: { ...CAT, stations: [...CAT.stations, { id: "compliance", no: "S7·1", name: "Compliance", agent: "ag-x", purpose: "", custom: true, project: "payments" }] } }) });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
    const rm = await byId("pcf-st-rm-compliance");
    expect(rm.getAttribute("data-reason")).toBe("2 work orders are at Compliance. Move them first.");
  });

  it("flow tab: the add-bay dialog posts the bay with the project version and shows a refusal inline", async () => {
    const calls = withPayments({ "POST /api/v1/projects/payments/flow/bays": () => ({ status: 409, body: { ok: false, msg: "This project already has that bay." } }) });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-flow"));
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
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-members"));
    fireEvent.click(await byId("pcf-rm-p-meera-line_lead"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    fireEvent.change(await byId("pcf-add-role"), { target: { value: "reviewer" } });
    fireEvent.click(await byId("pcf-add-go"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/members/p-meera/roles/reviewer") || c.path.includes("/members/p-tomas/roles/reviewer"))).toBe(true));
  });

  it("members tab: project admins choose who is on call, with the project version; a stale save says so", async () => {
    let stale = false;
    const calls = withPayments({ "PUT /api/v1/projects/payments/oncall": () => (stale ? { status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } } : ok({ oncall: ["p-meera"], version: 8 })) });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-members"));
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
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-approvers"));
    fireEvent.click(await byId("pcf-ap-g-G5"));
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
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-danger"));
    expect(await screen.findByText(/3 work orders, 1 running agents, 1 coding slots and 0 open PRs/)).toBeTruthy();
    fireEvent.click(await byId("pcf-archive"));
    const input = await waitFor(() => { const i = document.querySelector<HTMLInputElement>(".dlg input.input"); if (!i) throw new Error("no input"); return i; });
    fireEvent.change(input, { target: { value: "Payments Platform" } });
    fireEvent.submit(document.querySelector(".dlg-form")!);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/archive"))).toBeTruthy());
    const post = calls.find((c) => c.path.endsWith("/archive"))!;
    expect(post.body).toEqual({ confirmText: "Payments Platform" });
    expect(post.headers["if-match"]).toBe("7");
  });

  it("budget tab saves the monthly budget", async () => {
    const calls = withPayments({ "PATCH /api/v1/projects/payments/config": () => ok() });
    mount(<ProjectConfigView />);
    fireEvent.click(await byId("pcf-tab-budget"));
    const el = (await byId("pcf-bud-monthly")) as HTMLInputElement;
    fireEvent.change(el, { target: { value: "5000" } });
    fireEvent.blur(el);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ path: "budget.monthly", value: 5000 }));
  });
});
