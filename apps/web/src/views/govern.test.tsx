import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import PeopleView from "./people";
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
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  window.history.replaceState(null, "", "/"); // view state lives in the query string
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("People", () => {
  it("lists people in a paged table with status chips, and opens a person's sheet with roles and details", async () => {
    setup();
    mount(<PeopleView />);
    expect(await screen.findByText("Asha Raman")).toBeTruthy();
    expect(screen.getByText("Tomas Eriksen")).toBeTruthy();
    expect(screen.getAllByText("invited").length).toBeGreaterThan(0);
    expect(screen.getByText("1\u20132 of 2")).toBeTruthy();
    cleanup();
    window.location.hash = "#person/p-asha";
    mount(<PersonView />);
    expect(await screen.findByRole("heading", { name: "Asha Raman" })).toBeTruthy();
    // the prototype sheet: breadcrumb, KPI row, Roles panel with Grant role, Details panel, open work orders
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("People & teams");
    expect(screen.getByText("Open work orders")).toBeTruthy();
    expect(screen.getByText("Factory Admin").closest("li")?.textContent).toContain("whole factory");
    expect(screen.getByRole("button", { name: /Grant role/ })).toBeTruthy();
    expect(screen.getByText("GitHub").nextElementSibling?.textContent).toBe("Not linked");
    expect(screen.getByText("Open work orders requested")).toBeTruthy();
    // header carries Deactivate only
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("keeps the tab, filter and page in the address bar", async () => {
    setup();
    mount(<PeopleView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Teams/ }));
    expect(window.location.search).toContain("ppl.tab=teams");
    expect(await byId("ppl-teams")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /People/ }));
    fireEvent.change(await screen.findByLabelText("Search person"), { target: { value: "zzz" } });
    expect(window.location.search).toContain("ppl.q=zzz");
    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(window.location.search).not.toContain("ppl.q");
  });

  it("shows teams as a card grid with member avatars and a members and projects line, with team admin in a menu", async () => {
    setup();
    window.location.hash = "#people";
    window.history.replaceState(null, "", "/?ppl.tab=teams");
    mount(<PeopleView />);
    const card = await byId("ppl-team-platform");
    expect(card.textContent).toContain("2 members \u00b7 1 project");
    expect(card.textContent).not.toContain("Delete");
    // static card face (prototype): no control on it; the menu is the context menu
    expect(within(card).queryByRole("button")).toBeNull();
    fireEvent.contextMenu(card);
    expect(await screen.findByText("Edit team")).toBeTruthy();
  });

  it("grants a project role from the Grant role dialog and removes one with the X", async () => {
    const calls = setup({
      "PUT /api/v1/projects/payments/members/p-tomas/roles/project_admin": () => ({ body: { ok: true, msg: "Granted." } }),
      "DELETE /api/v1/projects/payments/members/p-tomas/roles/engineer": () => ({ body: { ok: true, msg: "Removed." } }),
    });
    window.location.hash = "#person/p-tomas";
    mount(<PersonView />);
    fireEvent.click(await screen.findByRole("button", { name: /Grant role/ }));
    fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "project_admin" } });
    // Scope lists Whole factory first (prototype); a project role needs a project
    expect(Array.from((document.getElementById("ppl-grant-scope") as HTMLSelectElement).options).map((o) => o.textContent)[0]).toBe("Whole factory");
    fireEvent.click(await byId("ppl-grant-submit"));
    expect(await screen.findByText(/applies to one project/)).toBeTruthy();
    fireEvent.change(document.getElementById("ppl-grant-scope") as HTMLSelectElement, { target: { value: "payments" } });
    fireEvent.click(await byId("ppl-grant-submit"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/roles/project_admin"))).toBe(true));
    expect(screen.queryByText("Save")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Remove role" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/roles/engineer"))).toBe(true));
  });

  it("invites a person with roles, an idempotency key and the factory role the form picked", async () => {
    const calls = setup({ "POST /api/v1/invites": () => ({ body: { ok: true, msg: "Invite sent to n@acme.dev.", person: { id: "p-n", name: "Nina" } } }) });
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    fireEvent.change(await screen.findByLabelText(/Full name/), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: "N@acme.dev" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Engineer" } });
    fireEvent.click(screen.getByText("Send invite"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/invites")).toBe(true));
    const c = calls.find((x) => x.path === "/api/v1/invites")!;
    expect(c.body).toEqual({ name: "Nina Park", email: "n@acme.dev", title: "Engineer", teams: ["platform"], roles: [{ role: "engineer", scope: "payments" }] });
    // the list stays put (no jump to the new person) and says so
    expect(await screen.findByText("Invite sent to n@acme.dev")).toBeTruthy();
    expect(window.location.hash).not.toContain("person");
    expect(c.headers["idempotency-key"]).toBeTruthy();
  });

  it("asks for a reason when the invite carries a factory role, and sends it", async () => {
    const calls = setup({ "POST /api/v1/invites": () => ({ body: { ok: true, msg: "Invite sent to n@acme.dev.", person: { id: "p-n", name: "Nina" } } }) });
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    fireEvent.change(await screen.findByLabelText(/Full name/), { target: { value: "Nina Park" } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: "n@acme.dev" } });
    expect(screen.queryByLabelText("Reason")).toBeNull();
    fireEvent.change(document.getElementById("ppl-inv-role") as HTMLSelectElement, { target: { value: "factory_admin" } });
    fireEvent.click(screen.getByText("Send invite"));
    expect(await screen.findByText(/at least 10 characters/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/api/v1/invites")).toBe(false);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Quarterly audit support" } });
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
    fireEvent.click(await screen.findByRole("button", { name: /Grant role/ }));
    fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "factory_admin" } });
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "Covering for Asha" } });
    fireEvent.click(await byId("ppl-grant-submit"));
    expect((await screen.findAllByText(/Sign in again to confirm this change/)).length).toBeGreaterThan(0);
  });

  it("a factory role asks why, sends the reason, and removing one can be undone straight after", async () => {
    const calls = setup({
      "PUT /api/v1/people/p-tomas/factory-roles/factory_admin": () => ({ body: { ok: true, msg: "Granted Factory Admin to Tomas Eriksen.", version: 2 } }),
      "DELETE /api/v1/people/p-asha/factory-roles/factory_admin": () => ({ body: { ok: true, msg: "Removed Factory Admin from Asha Raman.", version: 3 } }),
      "PUT /api/v1/people/p-asha/factory-roles/factory_admin ": () => ({ body: { ok: true, msg: "ok" } }),
    });
    window.location.hash = "#person/p-tomas";
    mount(<PersonView />);
    fireEvent.click(await screen.findByRole("button", { name: /Grant role/ }));
    fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "factory_admin" } });
    expect(await screen.findByLabelText("Reason")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Quarterly review" } });
    fireEvent.click(await byId("ppl-grant-submit"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/factory-roles/factory_admin"))).toBe(true));
    expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/factory-roles/factory_admin"))?.body).toEqual({ reason: "Quarterly review" });
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

  it("shows the prototype stats and tabs, keeps the tab in the URL, and filters the matrix with a search and a group select", async () => {
    setup();
    mount(<AccessView />);
    expect(await screen.findByText("governed")).toBeTruthy();
    expect(screen.getByText("active or upcoming")).toBeTruthy();
    expect(screen.getByText("of 2 on")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Role matrix", "Roles", "Policies", "Freezes", "Access check"]);
    expect(await screen.findByText("3 actions")).toBeTruthy();
    fireEvent.change(await byId("acc-mx-q"), { target: { value: "policy" } });
    expect(window.location.search).toContain("acc.q=policy");
    expect(screen.getByLabelText("Factory Admin can Edit policy")).toBeTruthy();
    expect(screen.queryByLabelText("Engineer can Release")).toBeNull();
    // the cell is a square checkbox, not a switch
    expect(screen.getByLabelText("Factory Admin can Edit policy").getAttribute("role")).toBeNull();
    fireEvent.change(await byId("acc-mx-q"), { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
    fireEvent.click(await byId("acc-tab-roles"));
    expect(window.location.search).toContain("acc.tab=roles");
    const heads = Array.from((await byId("acc-roles-table")).querySelectorAll("thead th")).map((h) => h.textContent?.replace(/[\u2191\u2193]/g, ""));
    expect(heads).toEqual(["Role", "Level", "Members", "Actions"]);
  });

  it("lists freezes as rows with a status chip and a trash button, and opens New change freeze from the panel header", async () => {
    setup();
    window.history.replaceState(null, "", "/?acc.tab=freezes");
    mount(<AccessView />);
    const row = await byId("acc-frz-FRZ-01");
    expect(row.textContent).toContain("active");
    expect(within(row).getByRole("button", { name: "Remove freeze" })).toBeTruthy();
    fireEvent.click(await byId("acc-add-freeze"));
    expect((await screen.findByText("New change freeze")).textContent).toBe("New change freeze");
    // the prototype's dialog: Name, From, To (defaults 20 Dec to 3 Jan), no repo picker, no intro
    expect(screen.getByLabelText(/^From/)).toBeTruthy();
    expect(screen.getByLabelText(/^To/)).toBeTruthy();
    expect(screen.queryByLabelText(/Repos/)).toBeNull();
    expect((screen.getByLabelText(/^From/) as HTMLInputElement).value).toMatch(/-12-20$/);
    expect((screen.getByLabelText(/^To/) as HTMLInputElement).value).toMatch(/-01-03$/);
    // the row reads "13 Nov 2026 \u2192 17 Nov 2026" style dates
  });

  it("renders policies, and the engine-owned ones cannot be edited", async () => {
    setup();
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    expect(await screen.findByText("Release window")).toBeTruthy();
    expect(screen.getByText("Freeze rule")).toBeTruthy();
    expect(document.getElementById("acc-pol-menu-POL-110")).toBeNull(); // static rows: no menu button
    expect(document.getElementById("acc-add-policy")).toBeNull();
    fireEvent.contextMenu((await byId("acc-pol-POL-110")).querySelector("b")!);
    const edit110 = (await screen.findByText("Edit policy")).closest("button, [role=menuitem]")!;
    expect(edit110.getAttribute("aria-disabled")).toBe("true");
    expect(edit110.getAttribute("data-reason") ?? edit110.textContent).toContain("Freeze rules come from the freeze list");
  });

  it("checks locally from the role matrix and always answers with a callout in the prototype's words", async () => {
    const calls = setup();
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-check"));
    await waitFor(() => expect((document.getElementById("acc-sim-person") as HTMLSelectElement).value).toBe("p-asha"));
    fireEvent.click(screen.getByText("Check"));
    const res = await byId("acc-sim-result");
    expect(res.className).toContain("bad");
    expect(res.textContent).toBe("DeniedNone of Asha Raman's roles grant wo.submit in Payments Platform.");
    fireEvent.change(document.getElementById("acc-sim-action") as HTMLSelectElement, { target: { value: "release" } });
    fireEvent.click(screen.getByText("Check"));
    await waitFor(() => expect(document.getElementById("acc-sim-result")?.textContent).toBe("AllowedAsha Raman holds a role that grants release."));
    expect(calls.some((c) => c.path === "/api/v1/access/simulate")).toBe(false);
  });

  it("shows inline field errors and focuses the first invalid field in the invite and team dialogs", async () => {
    setup();
    mount(<PeopleView />);
    fireEvent.click(await screen.findByText("Invite person"));
    fireEvent.click(await screen.findByText("Send invite"));
    expect(await screen.findByText("Full name is required.")).toBeTruthy();
    expect(screen.getByText("Work email is required.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("ppl-inv-name"));
  });

  it("the person sheet ends at Open work orders (no History section)", async () => {
    setup();
    window.location.hash = "#person/p-asha";
    mount(<PersonView />);
    expect(await screen.findByText("Open work orders")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "History" })).toBeNull();
    expect(document.getElementById("ppl-history-panel")).toBeNull();
  });

  it("edits a matrix cell with the matrix version as If-Match", async () => {
    const calls = setup({ "PUT /api/v1/access/matrix/engineer/release": () => ({ body: { ok: true, msg: "Engineer can now release.", version: 5 } }) });
    mount(<AccessView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Role matrix/ }));
    const sw = await screen.findByLabelText("Engineer can Release");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/access/matrix/engineer/release")).toBe(true));
    const c = calls.find((x) => x.method === "PUT")!;
    expect(c.body).toEqual({ on: true });
    expect(c.headers["if-match"]).toBe("4");
    // the Factory Admin column is a locked, disabled box (prototype)
    expect((screen.getByLabelText("Factory Admin can Release") as HTMLInputElement).disabled).toBe(true);
    // rights a role must keep so nobody is locked out stay locked in the UI
    expect(screen.getByLabelText("Factory Admin can Edit policy").getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a stale matrix refusal", async () => {
    setup({ "PUT /api/v1/access/matrix/engineer/release": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount(<AccessView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Role matrix/ }));
    fireEvent.click(await screen.findByLabelText("Engineer can Release"));
    expect(await screen.findByText(/changed since you loaded it/)).toBeTruthy();
  });

  it("adds a policy through the dialog with a preview and the policy body", async () => {
    const calls = setup({ "POST /api/v1/policies": () => ({ body: { ok: true, msg: "POL-111 added.", id: "POL-111", version: 1 } }) });
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    fireEvent.contextMenu((await byId("acc-pol-POL-101")).querySelector("b")!);
    fireEvent.click(await screen.findByText("Add policy"));
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
    fireEvent.click(await byId("acc-tab-policies"));
    fireEvent.click(await byId("acc-pol-on-POL-101"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
    // versioned config endpoints refuse a request without If-Match (409 "version required"), so every toggle sends the version it loaded
    expect(calls.find((c) => c.method === "PATCH")?.headers["if-match"]).toMatch(/^\d+$/);
    fireEvent.click(await screen.findByRole("tab", { name: /Freezes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove freeze" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/freezes/FRZ-01/end")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/freezes/FRZ-01/end")?.headers["if-match"]).toBe("2");
  });

  it("locks everything when policy.edit and role.edit are denied", async () => {
    setup({}, ["policy.edit", "role.edit"]);
    mount(<AccessView />);
    fireEvent.click(await byId("acc-tab-policies"));
    fireEvent.contextMenu((await byId("acc-pol-POL-101")).querySelector("b")!);
    const add = (await screen.findByText("Add policy")).closest("button, [role=menuitem]")!;
    await waitFor(() => expect(add.getAttribute("aria-disabled")).toBe("true"));
    expect((await byId("acc-pol-on-POL-101")).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText(/Read-only for you/).length).toBeGreaterThan(0);
  });
});

describe("Security", () => {
  it("shows the locked sheet with a way home when the settings read is refused, instead of a blank page", async () => {
    setup({ "GET /api/v1/security": () => ({ status: 403, body: { ok: false, msg: "Needs security.manage." } }) });
    mount(<SecurityView />);
    expect(await screen.findByText("No access to this sheet")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Security" })).toBeTruthy();
    expect(screen.getByText("Back to Home")).toBeTruthy();
  });

  it("toggles a setting with PATCH {path, value} and the settings version", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 8 } }) });
    mount(<SecurityView />);
    fireEvent.click(await screen.findByLabelText("Allow GitHub sign-in", { selector: "input" }).catch(() => document.getElementById("sec-gh") as HTMLElement));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.body).toEqual({ path: "githubLogin", value: false });
    expect(c.headers["if-match"]).toBe("7");
  });

  it("keeps the one you signed in with, and refuses an allow list that would lock you out", async () => {
    const calls = setup();
    mount(<SecurityView />);
    const rm = await byId("sec-dom-rm-acme_dev");
    expect(rm.getAttribute("aria-disabled")).toBe("true");
    expect(rm.getAttribute("data-reason")).toContain("lock you out");
    // this browser (10.4.0.12) is covered only by 10.0.0.0/8
    fireEvent.change(await byId("sec-ip"), { target: { value: "192.0.2.0/24" } });
    fireEvent.click(await byId("sec-save"));
    expect(await screen.findByText(/would lock you out: your address 10.4.0.12/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("validates a CIDR before sending", async () => {
    const calls = setup();
    mount(<SecurityView />);
    fireEvent.change(await byId("sec-ip"), { target: { value: "nope" } });
    fireEvent.click(await byId("sec-save"));
    expect(await screen.findByText("Each line must be a CIDR such as 10.0.0.0/8.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("lists sessions and revokes another one after a confirmation", async () => {
    const calls = setup({ "DELETE /api/v1/sessions/s2": () => ({ body: { ok: true, msg: "Session revoked." } }) });
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Sessions/ }));
    fireEvent.click(await byId("sec-ses-rv-s2"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(await byId("sec-ses-ok"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/sessions/s2")).toBe(true));
  });

  it("shows the sign-in log with failures and filters by outcome", async () => {
    setup();
    mount(<SecurityView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Sign-in log/ }));
    expect(await screen.findByText("domain not allowed")).toBeTruthy();
    fireEvent.change(await byId("sec-hist-f-outcome"), { target: { value: "success" } });
    await waitFor(() => expect(screen.queryByText("domain not allowed")).toBeNull());
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
