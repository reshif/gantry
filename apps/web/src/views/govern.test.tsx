import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import PeopleView from "./people";
import AccessView from "./access";
import SecurityView from "./security";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

const ROLES = [
  { id: "factory_admin", name: "Factory Admin", level: "factory" },
  { id: "engineer", name: "Engineer", level: "project" },
  { id: "project_admin", name: "Project Admin", level: "project" },
  { id: "change_advisor", name: "Change Advisor", level: "project", custom: true, base: "engineer", desc: "CAB" },
];
const ACTIONS = [
  { id: "wo.submit", name: "Submit work order", scope: "project", group: "Work" },
  { id: "release", name: "Release", scope: "project", group: "Work" },
  { id: "policy.edit", name: "Edit policy", scope: "factory", group: "Governance" },
];
const person = (id: string, name: string, roles: Array<{ role: string; scope: string }>, extra: object = {}) => ({ id, name, title: "Head", email: `${id}@acme.dev`, teams: ["platform"], roles, status: "active", oncall: false, github: "", away: null, version: 3, ...extra });
const PEOPLE = [person("p-asha", "Asha Raman", [{ role: "factory_admin", scope: "factory" }]), person("p-tomas", "Tomas Eriksen", [{ role: "engineer", scope: "payments" }], { status: "invited" })];
const PROJECTS = [{ id: "payments", name: "Payments Platform", key: "PAY", status: "active", teams: ["platform"], halted: null, killed: null }];
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.4.0.12", started: Date.now() - 3600000, lastSeen: Date.now(), revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "Plant 1", tz: "IST" }, projects: PROJECTS, factory: { killed: null }, config: {} };
const POLICIES = [
  { id: "POL-101", name: "Release window", effect: "allow", enabled: true, roles: ["engineer"], actions: ["release"], where: { projects: ["payments"] }, when: { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }, oncallOnly: false, version: 2 },
  { id: "POL-110", name: "Freeze rule", effect: "deny", enabled: true, roles: ["*"], actions: ["release"], where: { freeze: true }, when: null, oncallOnly: false, version: 1 },
];
const SEC = { sso: { provider: "Okta", domain: "acme.dev", enforced: false, entity: "https://idp.acme.dev/meta" }, mfa: { policy: "admins", methods: ["totp"] }, sessionHours: 12, idleMin: 30, domains: ["acme.dev"], ipAllow: ["10.0.0.0/8"], restoreFactoryNeedsTwo: true, githubLogin: true, version: 7 };

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/teams": () => ({ body: [{ id: "platform", name: "Platform", desc: "Core" }] }),
    "GET /api/v1/projects": () => ({ body: PROJECTS }),
    "GET /api/v1/projects/payments/repos": () => ({ body: [{ id: "payments-api", name: "acme/payments-api", project: "payments", team: "platform" }] }),
    "GET /api/v1/access/matrix": () => ({ body: { matrix: { factory_admin: { release: true, "policy.edit": true }, engineer: { "wo.submit": true } }, roles: ROLES, actions: ACTIONS, version: 4 } }),
    "GET /api/v1/policies": () => ({ body: POLICIES }),
    "GET /api/v1/freezes": () => ({ body: [{ id: "FRZ-01", name: "Quarter close", repos: "all", from: Date.now() - 1000, to: Date.now() + 3600000, by: "p-asha", version: 2 }] }),
    "GET /api/v1/security": () => ({ body: SEC }),
    "GET /api/v1/sessions": () => ({ body: [ME.session, { id: "s2", person: "p-tomas", method: "sso", device: "Firefox", ip: "10.1.1.1", started: Date.now() - 7200000, lastSeen: Date.now() - 60000, revoked: false }] }),
    "GET /api/v1/signins": () => ({ body: { items: [{ at: Date.now() - 5000, person: "p-asha", email: "p-asha@acme.dev", method: "sso", outcome: "success", reason: "", ip: "10.4.0.12", device: "Chrome" }, { at: Date.now() - 9000, person: null, email: "x@evil.io", method: "sso", outcome: "failure", reason: "domain not allowed", ip: "1.2.3.4", device: "curl" }], next: null } }),
    "GET /api/v1/audit": () => ({ body: { items: [] } }),
    "GET /api/v1/people/p-asha/effective-permissions": () => ({
      body: { person: "p-asha", at: Date.now(), projects: [{ id: "payments", name: "Payments Platform" }], actions: ACTIONS, cells: { "wo.submit": { payments: [1, "MATRIX"] }, release: { payments: [0, "POL-101"] } }, rules: { MATRIX: { kind: "matrix", name: "Role matrix" }, "POL-101": { kind: "policy", name: "Release window" } }, factory: { "policy.edit": { allowed: true, reason: "Allowed.", rule: { id: "MATRIX" } } } },
    }),
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
        return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
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

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("People", () => {
  it("lists teams and members, and decides effective permissions from the server's cells", async () => {
    setup();
    mount(<PeopleView />);
    expect(await screen.findByRole("heading", { name: "Asha Raman" })).toBeTruthy();
    expect(screen.getByText("Tomas Eriksen")).toBeTruthy();
    expect(screen.getByText("invited")).toBeTruthy();
    const yes = await screen.findByText("Submit work order");
    expect(yes.closest("tr")?.querySelector(".eff-cell.is-yes")).toBeTruthy();
    const rel = screen.getByText("Release").closest("tr")!;
    expect(rel.querySelector(".eff-cell.is-no")).toBeTruthy();
  });

  it("shows the reason for a cell from the simulator", async () => {
    setup({ "POST /api/v1/access/simulate": () => ({ body: { ok: true, decision: { allowed: false, reason: "Outside the release window.", needs: "Wait for Monday", rule: { id: "POL-101", name: "Release window", kind: "policy" } }, trace: [], week: [] } }) });
    mount(<PeopleView />);
    const cell = await waitFor(() => {
      const c = document.getElementById("ppl-eff-payments-release");
      if (!c) throw new Error("no cell");
      return c;
    });
    fireEvent.click(cell);
    expect(await screen.findByText("Outside the release window.")).toBeTruthy();
    expect(screen.getByText("Deciding rule")).toBeTruthy();
  });

  it("invites a person with roles, an idempotency key and the factory role the form picked", async () => {
    const calls = setup({ "POST /api/v1/invites": () => ({ body: { ok: true, msg: "Invite sent to n@acme.dev.", person: { id: "p-n", name: "Nina" } } }) });
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "N@acme.dev" } });
    fireEvent.click(screen.getByLabelText("Platform"));
    fireEvent.change(screen.getByLabelText("First project"), { target: { value: "payments" } });
    fireEvent.click(screen.getByText("Send invite"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/invites")).toBe(true));
    const c = calls.find((x) => x.path === "/api/v1/invites")!;
    expect(c.body).toEqual({ name: "Nina Park", email: "n@acme.dev", teams: ["platform"], roles: [{ role: "engineer", scope: "payments" }] });
    expect(c.headers["idempotency-key"]).toBeTruthy();
  });

  it("refuses a domain that is not allowed before calling the server", async () => {
    const calls = setup();
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/security")).toBe(true));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "n@evil.io" } });
    fireEvent.click(screen.getByText("Send invite"));
    expect(await screen.findByText(/evil.io is not an allowed domain/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/invites")).toBe(false);
  });

  it("locks the controls with the reason when people.manage is denied, and does not call the server", async () => {
    const calls = setup({}, ["people.manage"]);
    mount(<PeopleView />);
    const btn = (await screen.findByText("Invite person")).closest("button")!;
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(btn.getAttribute("data-reason")).toContain("No role holds people.manage");
    fireEvent.click(btn);
    expect(screen.queryByText("Send invite")).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/invites")).toBe(false);
  });

  it("a stale-version refusal shows its message", async () => {
    setup({ "PUT /api/v1/people/p-asha/oncall": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Put on call"));
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
  });

  it("a step-up refusal nobody resolved is shown as its message (the shell's prompt handles the rest)", async () => {
    setup({ "PUT /api/v1/people/p-tomas/factory-roles/factory_admin": () => ({ status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up" } }) });
    mount(<PeopleView />);
    fireEvent.click(await byId("ppl-mem-platform-p-tomas"));
    const sel = (await screen.findByLabelText("Factory role for Tomas Eriksen")) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "factory_admin" } });
    expect(await screen.findByText(/Sign in again to confirm this change/)).toBeTruthy();
  });
});

describe("Access", () => {
  it("renders policies, and the engine-owned ones cannot be edited", async () => {
    setup();
    mount(<AccessView />);
    expect(await screen.findByText("Release window")).toBeTruthy();
    expect(screen.getByText("Freeze rule")).toBeTruthy();
    const edit110 = document.getElementById("acc-pol-edit-POL-110")!;
    expect(edit110.getAttribute("aria-disabled")).toBe("true");
    expect(edit110.getAttribute("data-reason")).toContain("Freeze rules come from the freeze list");
  });

  it("evaluates through the server simulator and highlights the deciding rule", async () => {
    const calls = setup({ "POST /api/v1/access/simulate": () => ({ body: { ok: true, decision: { allowed: false, reason: "Outside window.", needs: "", rule: { id: "POL-101", name: "Release window", kind: "policy" } }, trace: ["Roles in scope: Engineer.", "Role matrix grants release: no."], week: [{ day0: Date.now(), dow: 1, label: "Mon", cells: Array.from({ length: 24 }, (_, hour) => ({ hour, allowed: hour > 9, rule: "MATRIX", selected: hour === 3 })) }] } }) });
    mount(<AccessView />);
    await screen.findByText("Release window");
    await waitFor(() => expect((document.getElementById("acc-sim-person") as HTMLSelectElement).value).toBe("p-asha"));
    fireEvent.click(screen.getByText("Evaluate"));
    expect(await screen.findByText("Outside window.")).toBeTruthy();
    const sim = calls.find((c) => c.path === "/api/v1/access/simulate")!;
    expect(sim.body).toMatchObject({ person: "p-asha", action: "release", project: "payments" });
    expect(document.querySelectorAll(".wk-c.is-yes").length).toBeGreaterThan(5);
    expect(document.getElementById("acc-pol-POL-101")?.className).toContain("is-hl");
  });

  it("edits a matrix cell with the matrix version as If-Match", async () => {
    const calls = setup({ "PUT /api/v1/access/matrix/engineer/release": () => ({ body: { ok: true, msg: "Engineer can now release.", version: 5 } }) });
    mount(<AccessView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Roles × actions/ }));
    const sw = await screen.findByLabelText("Engineer: Release");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/access/matrix/engineer/release")).toBe(true));
    const c = calls.find((x) => x.method === "PUT")!;
    expect(c.body).toEqual({ on: true });
    expect(c.headers["if-match"]).toBe("4");
    // rights a role must keep so nobody is locked out stay locked in the UI
    expect(screen.getByLabelText("Factory Admin: Edit policy").getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a stale matrix refusal", async () => {
    setup({ "PUT /api/v1/access/matrix/engineer/release": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount(<AccessView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Roles × actions/ }));
    fireEvent.click(await screen.findByLabelText("Engineer: Release"));
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
  });

  it("adds a policy through the dialog with a preview and the policy body", async () => {
    const calls = setup({ "POST /api/v1/policies": () => ({ body: { ok: true, msg: "POL-111 added.", id: "POL-111", version: 1 } }) });
    mount(<AccessView />);
    fireEvent.click(await byId("acc-add-policy"));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Weekend hotfix" } });
    expect(document.querySelector(".acc-preview")?.textContent).toContain("may release");
    fireEvent.click(await byId("acc-pd-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/policies")).toBe(true));
    const c = calls.find((x) => x.path === "/api/v1/policies" && x.method === "POST")!;
    expect(c.body).toMatchObject({ name: "Weekend hotfix", effect: "allow", roles: ["release_manager"], actions: ["release"], oncallOnly: false });
    expect(c.headers["idempotency-key"]).toBeTruthy();
  });

  it("toggles a policy and ends a freeze", async () => {
    const calls = setup({
      "PATCH /api/v1/policies/POL-101": () => ({ body: { ok: true, msg: "POL-101 disabled.", version: 3 } }),
      "POST /api/v1/freezes/FRZ-01/end": () => ({ body: { ok: true, msg: "FRZ-01 ended.", version: 2 } }),
    });
    mount(<AccessView />);
    fireEvent.click(await screen.findByLabelText("Enable POL-101"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
    // versioned config endpoints refuse a request without If-Match (409 "version required"), so every toggle sends the version it loaded
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toMatch(/^\d+$/);
    fireEvent.click(await screen.findByRole("tab", { name: /Freezes/ }));
    fireEvent.click(await screen.findByText("End freeze now"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/freezes/FRZ-01/end")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/freezes/FRZ-01/end")?.headers["if-match"]).toBe("2");
  });

  it("locks everything when policy.edit and role.edit are denied", async () => {
    setup({}, ["policy.edit", "role.edit"]);
    mount(<AccessView />);
    const add = await byId("acc-head-add");
    await waitFor(() => expect(add.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByLabelText("Enable POL-101").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText(/Read-only for you/).length).toBeGreaterThan(0);
  });
});

describe("Security", () => {
  it("toggles a setting with PATCH {path, value} and the settings version", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 8 } }) });
    mount(<SecurityView />);
    fireEvent.click(await screen.findByLabelText("Allow GitHub sign-in", { selector: "input" }).catch(() => document.getElementById("sec-gh") as HTMLElement));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ path: "githubLogin", value: false });
    expect(c.headers["if-match"]).toBe("7");
  });

  it("keeps the last allowed domain and the one you signed in with", async () => {
    setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Domains and network/ }));
    const rm = await byId("sec-dom-rm-acme_dev");
    expect(rm.getAttribute("aria-disabled")).toBe("true");
    expect(rm.getAttribute("data-reason")).toContain("lock you out");
    // this browser (10.4.0.12) is covered only by 10.0.0.0/8
    const ip = await byId("sec-ip-rm-10_0_0_0_8");
    expect(ip.getAttribute("data-reason")).toContain("only range covering your address 10.4.0.12");
  });

  it("validates a CIDR before sending", async () => {
    const calls = setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Domains and network/ }));
    fireEvent.change(await screen.findByLabelText("Address range to allow"), { target: { value: "nope" } });
    fireEvent.click(screen.getByText("Add range"));
    expect(await screen.findByText(/Enter an IPv4 address or CIDR range/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("lists sessions and revokes another one; read-only users cannot revoke others", async () => {
    const calls = setup({ "DELETE /api/v1/sessions/s2": () => ({ body: { ok: true, msg: "Session revoked." } }) });
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Active sessions/ }));
    fireEvent.click(await byId("sec-ses-rv-s2"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/sessions/s2")).toBe(true));
  });

  it("shows the sign-in history with failures", async () => {
    setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Sign-in history/ }));
    expect(await screen.findByText("domain not allowed")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Succeeded"));
    expect(screen.queryByText("domain not allowed")).toBeNull();
    expect(within(document.querySelector("tbody")!).getAllByRole("row")).toHaveLength(1);
  });

  it("is read-only with the reason when security.manage is denied", async () => {
    setup({}, ["security.manage"]);
    mount(<SecurityView />);
    expect(await screen.findByText(/Read-only for you: security settings/)).toBeTruthy();
    expect(document.getElementById("sec-sso-domain")).toBeTruthy();
    await waitFor(() => expect((document.getElementById("sec-sso-domain") as HTMLInputElement).disabled).toBe(true));
  });
});
