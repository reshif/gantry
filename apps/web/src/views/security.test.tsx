import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import SecurityView from "./security";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; ifMatch?: string }

const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman"), person("p-meera", "Meera Rao")];
const ME = { person: { ...PEOPLE[0], email: "asha@acme.dev" }, session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.5", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [], factory: { killed: null }, config: {} };

const SEC = {
  sso: { provider: "Okta", domain: "acme.dev", enforced: true, entity: "https://acme.okta.com/metadata" },
  mfa: { policy: "admins", methods: ["totp"] }, sessionHours: 12, idleMin: 30, domains: ["acme.dev", "partner.example"], ipAllow: ["10.0.0.0/8"],
  restoreFactoryNeedsTwo: true, githubLogin: false, researchHosts: ["docs.example.com"], chatCapUsdPerDay: null, version: 3,
};
const NOW = Date.now();
const session = (id: string, who: string, o: object = {}) => ({ id, person: who, method: "sso", device: "Chrome", ip: "10.0.0.7", started: NOW - 3600000, lastSeen: NOW - 60000, revoked: false, ...o });
const SESSIONS = [session("s1", "p-asha"), session("s2", "p-meera"), session("s3", "p-meera", { revoked: true })];
const signin = (o: object) => ({ at: NOW - 600000, person: "p-meera", email: "meera@acme.dev", method: "sso", outcome: "success", reason: "", ip: "10.0.0.7", device: "Chrome", ...o });
const SIGNINS = [signin({}), signin({ outcome: "failure", person: null, email: "mallory@evil.test", reason: "Domain not allowed", at: NOW - 1200000 })];

const BASE: Record<string, Handler> = {
  "GET /api/v1/me": () => ({ body: ME }),
  "GET /api/v1/people": () => ({ body: PEOPLE }),
  "GET /api/v1/agents": () => ({ body: [] }),
  "GET /api/v1/security": () => ({ body: SEC }),
  "GET /api/v1/sessions": () => ({ body: SESSIONS }),
  "GET /api/v1/signins": () => ({ body: SIGNINS }),
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = { ...BASE, ...extra };
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
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><SecurityView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const text = () => document.body.textContent ?? "";
const locked = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled;

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

describe("Security screen", () => {
  it("shows the prototype's two cards: Single sign-on as key/value rows (no Edit, no GitHub row) and Multi-factor with the three fields only", async () => {
    setup();
    mount();
    expect((await byId("sec-sso-domain")).textContent).toBe("acme.dev");
    expect((await byId("sec-sso-provider")).textContent).toBe("Okta");
    expect((await byId("sec-sso-entity")).textContent).toBe("https://acme.okta.com/metadata");
    expect((await byId("sec-sso-enforced") as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("sec-sso-edit")).toBeNull();
    expect(document.getElementById("sec-gh")).toBeNull();
    const titles = [...document.querySelectorAll(".card-h h2")].map((h) => h.textContent);
    expect(titles).toEqual(["Single sign-on", "Multi-factor"]);
    expect(((await byId("sec-mfa-policy")) as HTMLSelectElement).value).toBe("admins");
    expect([...(await byId("sec-mfa-policy")).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Everyone", "Admins and approvers", "No one"]);
    expect(((await byId("sec-hours")) as HTMLInputElement).value).toBe("12");
    expect(((await byId("sec-idle")) as HTMLInputElement).value).toBe("30");
    expect(document.getElementById("sec-mfa-notice")).toBeNull();
    expect(text()).not.toContain("Allowed methods");
    expect(document.querySelector(".stats")).toBeNull();
    expect(document.querySelector(".lock-note")).toBeNull();
  });

  it("has exactly the prototype's three tabs, in the URL", async () => {
    setup();
    mount();
    await byId("sec-sso-domain");
    expect([...document.querySelectorAll("[role=tab]")].map((t) => t.firstChild?.textContent)).toEqual(["Sign-in", "Sessions", "Network and restore"]);
    fireEvent.click(await byId("sec-tab-network"));
    expect(window.location.search).toBe("?tab=network");
    fireEvent.click(await byId("sec-tab-signin"));
    expect(window.location.search).toBe("");
  });

  it("opens on the tab named in the URL", async () => {
    window.history.replaceState(null, "", "/?tab=sessions");
    setup();
    mount();
    await byId("sec-ses-rv-s2");
  });

  it("saves the session length as a number field", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    const hours = await byId("sec-hours");
    fireEvent.change(hours, { target: { value: "8" } });
    fireEvent.blur(hours);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ body: { path: "sessionHours", value: 8 } });
  });

  it("lists the IP allow list with Add range and Remove and the Restore rules card, nothing else", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-tab-network"));
    await byId("sec-ip-add");
    expect([...document.querySelectorAll(".card-h h2")].slice(0, 2).map((h) => h.textContent)).toEqual(["IP allow list", "Restore rules"]);
    expect(text()).toContain("10.0.0.0/8");
    for (const gone of ["sec-dom-form", "sec-rh-form", "sec-chatcap-form", "sec-kill-stepup", "sec-stepup-window"]) expect(document.getElementById(gone)).toBeNull();
    expect(text()).not.toContain("active");
    // adding goes through a dialog with the prototype's error text
    fireEvent.click(await byId("sec-ip-add"));
    fireEvent.change(await byId("sec-ip-new"), { target: { value: "nonsense" } });
    fireEvent.click(await byId("sec-ip-add-ok"));
    await waitFor(() => expect(text()).toContain("Use CIDR, e.g. 198.51.100.0/24"));
    fireEvent.change(await byId("sec-ip-new"), { target: { value: "198.51.100.0/24" } });
    fireEvent.click(await byId("sec-ip-add-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ body: { path: "ipAllow", value: ["10.0.0.0/8", "198.51.100.0/24"] } });
  });

  it("asks before removing an IP range, with the prototype's wording", async () => {
    window.history.replaceState(null, "", "/?tab=network");
    const calls = setup({ "GET /api/v1/security": () => ({ body: { ...SEC, ipAllow: ["10.0.0.0/8", "192.0.2.0/24"] } }), "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-ip-rm-192_0_2_0_24"));
    await waitFor(() => expect(text()).toContain("People connecting from this range will be refused."));
    expect(text()).toContain("Remove 192.0.2.0/24?");
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(await byId("sec-ip-rm-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ body: { path: "ipAllow", value: ["10.0.0.0/8"] } });
  });

  it("lists sessions in a sortable, paged table with Sign out and no Revoke-all, and the sign-in history below it", async () => {
    window.history.replaceState(null, "", "/?tab=sessions");
    setup();
    mount();
    await byId("sec-ses-rv-s2");
    expect(document.getElementById("sec-ses-rv-s3")).toBeNull();
    expect(document.getElementById("sec-ses-all")).toBeNull();
    expect(document.getElementById("sec-ses-rv-s2")?.textContent).toBe("Sign out");
    expect([...document.querySelectorAll("#sec-sessions-table th")].map((t) => t.textContent?.replace(/[↑↓]/g, ""))).toEqual(["Person", "Device", "IP", "Started", "MFA", ""]);
    await waitFor(() => expect(text()).toContain("mallory@evil.test"));
    expect(text()).toContain("Domain not allowed");
  });

  it("an old ?tab=history or ?tab=stop link lands on the section that now holds it", async () => {
    window.history.replaceState(null, "", "/?tab=history");
    setup();
    mount();
    await byId("sec-history-card");
    cleanup();
    window.history.replaceState(null, "", "/?tab=stop");
    mount();
    await byId("sec-stop-kill");
  });

  it("shows an empty sign-in history as zero rows rather than a blank panel", async () => {
    window.history.replaceState(null, "", "/?tab=sessions");
    setup({ "GET /api/v1/signins": () => ({ body: [] }) });
    mount();
    await waitFor(() => expect(text()).toContain("0 sign-ins · 0 failures in the last 24 hours"));
    expect(document.getElementById("sec-history-error")).toBeNull();
  });

  it("shows the failure with a retry in place of the settings, not a blank page", async () => {
    let fail = true;
    setup({ "GET /api/v1/security": () => (fail ? { status: 500, body: { ok: false, msg: "The settings store is down." } } : { body: SEC }) });
    mount();
    const err = await byId("sec-error");
    expect(err.textContent).toContain("Couldn't load security settings");
    expect(err.textContent).toContain("The settings store is down.");
    expect(document.getElementById("sec-sso-domain")).toBeNull();
    expect(document.querySelector(".page h1")?.textContent).toBe("Security");
    fail = false;
    fireEvent.click(await byId("sec-error-retry"));
    await byId("sec-sso-domain");
  });

  it("says the settings are not visible when the viewer holds neither security.manage nor policy.view", async () => {
    const calls = setup({}, ["security.manage", "policy.view"]);
    mount();
    const hidden = await byId("sec-hidden");
    expect(hidden.textContent).toContain("Not visible to you");
    expect(calls.some((c) => c.path === "/api/v1/security")).toBe(false);
  });

  it("shows a failed sessions read on the sessions tab while the rest of the page works", async () => {
    setup({ "GET /api/v1/sessions": () => ({ status: 500, body: { ok: false, msg: "Sessions are unavailable." } }) });
    mount();
    await byId("sec-sso-domain");
    fireEvent.click(await byId("sec-tab-sessions"));
    const err = await byId("sec-sessions-error");
    expect(err.textContent).toContain("Couldn't load sessions");
    expect(err.textContent).toContain("Sessions are unavailable.");
  });

  it("is read-only with the reason for someone who may only view: every control locked, no writes", async () => {
    const calls = setup({}, ["security.manage"]);
    mount();
    await waitFor(() => expect(document.querySelector(".sec-lock .lock-note")).toBeTruthy());
    expect(document.querySelector(".lock-note")?.textContent).toContain("Read-only for you");
    for (const id of ["sec-sso-enforced", "sec-mfa-policy", "sec-hours", "sec-idle"]) {
      expect(locked(await byId(id))).toBe(true);
    }
    fireEvent.click(await byId("sec-sso-enforced"));
    fireEvent.click(await byId("sec-tab-network"));
    await byId("sec-ip-add");
    for (const id of ["sec-ip-add", "sec-two"]) {
      expect(locked(await byId(id))).toBe(true);
    }
    expect(writes(calls)).toHaveLength(0);
  });

  it("lets a manager toggle Enforce SSO with the version they read", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-sso-enforced"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PATCH", path: "/api/v1/security", body: { path: "sso.enforced", value: false } });
  });

  it("sends the version it read with a setting change", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-sso-enforced"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.ifMatch).toBe("3");
  });

  it("shows a failed sign-in history read under the sessions table while the rest of the page works", async () => {
    window.history.replaceState(null, "", "/?tab=sessions");
    setup({ "GET /api/v1/signins": () => ({ status: 500, body: { ok: false, msg: "History is unavailable." } }) });
    mount();
    const err = await byId("sec-history-error");
    expect(err.textContent).toContain("History is unavailable.");
  });
});

describe("Security screen: emergency stop tab", () => {
  it("offers the factory kill with who may do it, lists the stops in force, and warns when a restore could not be approved", async () => {
    setup({ "GET /api/v1/people": () => ({ body: [PEOPLE[0]] }), "GET /api/v1/stops": () => ({ body: { items: [{ id: "project:payments", row: "r1", scope: "project", mode: "halt", reason: "Flaky tests", inFlight: null, by: "p-asha", at: NOW - 60000, version: 1, fencing: 1 }] } }) });
    mount();
    fireEvent.click(await byId("sec-tab-network"));
    expect(locked(await byId("sec-stop-kill"))).toBe(false);
    expect((await byId("sec-stop-warn")).textContent).toContain("a restore could not be approved");
    await waitFor(() => expect(document.getElementById("sec-stops-table")?.textContent).toContain("Flaky tests"));
    expect(text()).toContain("Needs two different Factory Admins and a fresh sign-in.");
  });

  it("locks the kill with the server's reason when kill.factory is denied", async () => {
    setup({ "GET /api/v1/stops": () => ({ body: { items: [] } }) }, ["kill.factory"]);
    mount();
    fireEvent.click(await byId("sec-tab-network"));
    const kill = await byId("sec-stop-kill");
    await waitFor(() => expect(locked(kill)).toBe(true));
    expect(kill.getAttribute("data-reason")).toContain("No role holds kill.factory");
    await waitFor(() => expect(text()).toContain("Nothing is stopped right now."));
  });
});
