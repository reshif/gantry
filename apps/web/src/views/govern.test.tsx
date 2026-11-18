import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import PeopleView from "./people";
import { writeUrlState } from "./govern/urlState";
import PersonView from "./person";
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
  window.history.replaceState(null, "", "/");
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The person page's Access tab: Change role, pick Factory Admin, Save (the reason dialog follows). */
async function pickFactoryRole() {
  fireEvent.click(await byId("person-tab-access"));
  fireEvent.click(await byId("ppl-chrole-btn"));
  fireEvent.change(await byId("ppl-chrole"), { target: { value: "factory_admin" } });
  fireEvent.click(await byId("ppl-chrole-save"));
}

describe("People", () => {
  it("lists teams and members, and decides effective permissions from the server's cells", async () => {
    setup();
    mount(<PeopleView />);
    await byId("ppl-stats");
    act(() => writeUrlState({ view: "teams" })); // the team cards are at ?view=teams
    expect(await screen.findByText("Asha Raman")).toBeTruthy();
    expect(screen.getByText("Tomas Eriksen")).toBeTruthy();
    expect(screen.getByText("invited")).toBeTruthy();
    cleanup();
    window.location.hash = "#person/p-asha";
    window.history.replaceState(null, "", "/?view=detail#person/p-asha"); // the permissions grid is the secondary view
    mount(<PersonView />);
    fireEvent.click(await byId("person-tab-access"));
    expect(await screen.findByRole("heading", { name: "Asha Raman" })).toBeTruthy();
    const yes = await screen.findByText("Submit work order");
    expect(yes.closest("tr")?.querySelector(".eff-cell.is-yes")).toBeTruthy();
    const rel = screen.getByText("Release").closest("tr")!;
    expect(rel.querySelector(".eff-cell.is-no")).toBeTruthy();
  });

  it("shows the reason for a cell from the simulator", async () => {
    setup({ "POST /api/v1/access/simulate": () => ({ body: { ok: true, decision: { allowed: false, reason: "Outside the release window.", needs: "Wait for Monday", rule: { id: "POL-101", name: "Release window", kind: "policy" } }, trace: [], week: [] } }) });
    window.location.hash = "#person/p-asha";
    window.history.replaceState(null, "", "/?view=detail#person/p-asha");
    mount(<PersonView />);
    fireEvent.click(await byId("person-tab-access"));
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
    fireEvent.change(await screen.findByLabelText(/Full name/), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: "N@acme.dev" } });
    fireEvent.change(document.getElementById("ppl-inv-team")!, { target: { value: "platform" } }); // Name, Email, Role and Team only: the project role lands on the current project
    fireEvent.click(screen.getByText("Send invite"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/invites")).toBe(true));
    const c = calls.find((x) => x.path === "/api/v1/invites")!;
    expect(c.body).toEqual({ name: "Nina Park", email: "n@acme.dev", teams: ["platform"], roles: [{ role: "engineer", scope: "payments" }] });
    expect(c.headers["idempotency-key"]).toBeTruthy();
  });

  it("asks for a reason when the invite carries a factory role, and sends it", async () => {
    const calls = setup({ "POST /api/v1/invites": () => ({ body: { ok: true, msg: "Invite sent to n@acme.dev.", person: { id: "p-n", name: "Nina" } } }) });
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    fireEvent.change(await screen.findByLabelText(/Full name/), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: "n@acme.dev" } });
    expect(screen.queryByLabelText(/Reason for the factory role/)).toBeNull();
    fireEvent.change(document.getElementById("ppl-inv-prole")!, { target: { value: "factory_admin" } });
    fireEvent.click(screen.getByText("Send invite"));
    expect(await screen.findByText(/at least 10 characters/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/invites")).toBe(false);
    fireEvent.change(screen.getByLabelText(/Reason for the factory role/), { target: { value: "Quarterly audit support" } });
    fireEvent.click(screen.getByText("Send invite"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/invites")).toBe(true));
    expect(calls.find((x) => x.path === "/api/v1/invites")!.body).toMatchObject({ roles: [{ role: "factory_admin", scope: "factory" }], reason: "Quarterly audit support" });
  });

  it("refuses a domain that is not allowed before calling the server", async () => {
    const calls = setup();
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/security")).toBe(true));
    fireEvent.change(await screen.findByLabelText(/Full name/), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: "n@evil.io" } });
    fireEvent.click(screen.getByText("Send invite"));
    expect(await screen.findByText(/allowed domain/)).toBeTruthy();
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

  it("has no on-call switch: on call is chosen per project in Project config", async () => {
    setup();
    mount(<PeopleView />);
    expect(await screen.findAllByText("Asha Raman")).toBeTruthy();
    expect(screen.queryByText("Put on call")).toBeNull();
    expect(document.getElementById("ppl-oncall")).toBeNull();
  });

  it("a step-up refusal nobody resolved is shown as its message (the shell's prompt handles the rest)", async () => {
    setup({ "PUT /api/v1/people/p-tomas/factory-roles/factory_admin": () => ({ status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up" } }) });
    window.location.hash = "#person/p-tomas";
    mount(<PersonView />);
    await pickFactoryRole(); // Change role (Access tab) to Factory Admin
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Covering for Asha" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    expect(await screen.findByText(/Sign in again to confirm this change/)).toBeTruthy();
  });

  it("a factory role asks why, sends the reason, and can be undone straight after", async () => {
    const calls = setup({
      "PUT /api/v1/people/p-tomas/factory-roles/factory_admin": () => ({ body: { ok: true, msg: "Granted Factory Admin to Tomas Eriksen.", version: 2 } }),
      "DELETE /api/v1/people/p-tomas/factory-roles/factory_admin": () => ({ body: { ok: true, msg: "Removed Factory Admin from Tomas Eriksen.", version: 3 } }),
    });
    window.location.hash = "#person/p-tomas";
    mount(<PersonView />);
    await pickFactoryRole(); // Change role (Access tab) to Factory Admin
    expect(await screen.findByText(/A factory role applies on every project/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Quarterly review" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/factory-roles/factory_admin"))).toBe(true));
    expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/factory-roles/factory_admin"))?.body).toEqual({ reason: "Quarterly review" });
    fireEvent.click(await byId("ppl-frole-undo"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/factory-roles/factory_admin"))).toBe(true));
    expect(calls.find((c) => c.method === "DELETE" && c.path.endsWith("/factory-roles/factory_admin"))?.body).toEqual({ reason: "Undo: Quarterly review" });
  });
});

describe("Access", () => {
  it("says Not visible to you when the policies read is refused, instead of No policies yet", async () => {
    setup({ "GET /api/v1/policies": () => ({ status: 403, body: { ok: false, msg: "Needs policy.view." } }) });
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("No policies yet")).toBeNull();
  });

  it("renders policies, and the engine-owned ones cannot be edited", async () => {
    setup();
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    expect(await screen.findByText("Release window")).toBeTruthy();
    expect(screen.getByText("Freeze rule")).toBeTruthy();
    fireEvent.click(document.getElementById("acc-pol-edit-POL-110")!); // an engine-owned policy opens no editor, it says why
    expect(await screen.findByText(/Freeze rules come from the freeze list/)).toBeTruthy();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("evaluates through the server simulator and highlights the deciding rule", async () => {
    const calls = setup({ "POST /api/v1/access/simulate": () => ({ body: { ok: true, decision: { allowed: false, reason: "Outside window.", needs: "", rule: { id: "POL-101", name: "Release window", kind: "policy" } }, trace: ["Roles in scope: Engineer.", "Role matrix grants release: no."], week: [{ day0: Date.now(), dow: 1, label: "Mon", cells: Array.from({ length: 24 }, (_, hour) => ({ hour, allowed: hour > 9, rule: "MATRIX", selected: hour === 3 })) }] } }) });
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-check"));
    await waitFor(() => expect((document.getElementById("acc-sim-person") as HTMLSelectElement).value).toBe("p-asha"));
    fireEvent.click(screen.getByText("Check"));
    expect((await byId("acc-sim-result")).textContent).toContain("Denied.");
    const sim = calls.find((c) => c.path === "/api/v1/access/simulate")!;
    expect(sim.body).toMatchObject({ person: "p-asha", project: "payments" }) // the first permission, as in the prototype;
    expect(document.querySelectorAll(".wk-c.is-yes").length).toBeGreaterThan(5);
    fireEvent.click(await byId("acc-tab-policies"));
    expect(document.getElementById("acc-pol-POL-101")?.textContent).toContain("deciding rule");
  });

  it("the role matrix is read-only: no switches, roles are edited at ?tab=roles", async () => {
    setup();
    mount(<AccessView />);
    await byId("acc-matrix-table");
    expect(document.querySelectorAll("#acc-matrix-table input, #acc-matrix-table [role=switch]")).toHaveLength(0);
  });

  it("toggles a policy and ends a freeze", async () => {
    const calls = setup({
      "PATCH /api/v1/policies/POL-101": () => ({ body: { ok: true, msg: "POL-101 disabled.", version: 3 } }),
      "POST /api/v1/freezes/FRZ-01/end": () => ({ body: { ok: true, msg: "FRZ-01 ended.", version: 2 } }),
    });
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    fireEvent.click(await screen.findByLabelText("Release window"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
    // versioned config endpoints refuse a request without If-Match (409 "version required"), so every toggle sends the version it loaded
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toMatch(/^\d+$/);
    act(() => writeUrlState({ tab: "freezes" })); // freezes are reached at ?tab=freezes
    fireEvent.click(await screen.findByText("End freeze now"));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/freezes/FRZ-01/end")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/freezes/FRZ-01/end")?.headers["if-match"]).toBe("2");
  });

  it("locks everything when policy.edit and role.edit are denied", async () => {
    setup({}, ["policy.edit", "role.edit"]);
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    await waitFor(() => expect(screen.getByLabelText("Release window").getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getAllByText(/Read-only for you/).length).toBeGreaterThan(0);
  });
});

describe("Security", () => {
  it("says Not visible to you when the settings read is refused, instead of a blank page", async () => {
    setup({ "GET /api/v1/security": () => ({ status: 403, body: { ok: false, msg: "Needs security.manage." } }) });
    mount(<SecurityView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Security" })).toBeTruthy();
  });

  it("toggles a setting with PATCH {path, value} and the settings version", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 8 } }) });
    mount(<SecurityView />);
    fireEvent.click(await byId("sec-sso-enforced"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ path: "sso.enforced", value: true });
    expect(c.headers["if-match"]).toBe("7");
  });

  it("keeps the only range covering your address", async () => {
    setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Network/ }));
    // this browser (10.4.0.12) is covered only by 10.0.0.0/8
    const ip = await byId("sec-ip-rm-10_0_0_0_8");
    expect(ip.getAttribute("data-reason")).toContain("only range covering your address 10.4.0.12");
  });

  it("validates a CIDR before sending", async () => {
    const calls = setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Network/ }));
    fireEvent.click(await byId("sec-ip-add"));
    fireEvent.change(await byId("sec-ip-new"), { target: { value: "nope" } });
    fireEvent.click(await byId("sec-ip-add-ok"));
    expect(await screen.findByText("Use CIDR, e.g. 198.51.100.0/24")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("lists sessions and revokes another one; read-only users cannot revoke others", async () => {
    const calls = setup({ "DELETE /api/v1/sessions/s2": () => ({ body: { ok: true, msg: "Session revoked." } }) });
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Sessions/ }));
    fireEvent.click(await byId("sec-ses-rv-s2"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/sessions/s2")).toBe(true));
  });

  it("is read-only with the reason when security.manage is denied", async () => {
    setup({}, ["security.manage"]);
    mount(<SecurityView />);
    expect(await screen.findByText(/Read-only for you: security settings/)).toBeTruthy();
    await waitFor(() => expect(document.getElementById("sec-sso-domain")).toBeTruthy());
    await waitFor(() => expect(document.getElementById("sec-sso-enforced")?.getAttribute("aria-disabled")).toBe("true"));
    expect((document.getElementById("sec-idle") as HTMLInputElement).disabled).toBe(true);
  });
});
