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
  it("shows the sign-in settings and the header summary, with every control enabled for an admin", async () => {
    setup();
    mount();
    expect(((await byId("sec-sso-domain")) as HTMLInputElement).value).toBe("acme.dev");
    expect((await byId("sec-sso-enforced") as HTMLInputElement).checked).toBe(true);
    expect((await byId("sec-gh") as HTMLInputElement).checked).toBe(false);
    expect(((await byId("sec-idle")) as HTMLInputElement).value).toBe("30");
    await waitFor(() => expect(text()).toContain("SSOEnforcedOkta"));
    expect(text()).toContain("30 min idle");
    expect(text()).toContain("Failed sign-ins1recent");
    expect(document.querySelector(".lock-note")).toBeNull();
    expect(locked(await byId("sec-sso-domain"))).toBe(false);
  });

  it("shows the MFA policy as recorded, with the methods, and keeps the not-enforced note as a tooltip", async () => {
    setup();
    mount();
    await waitFor(() => expect(text()).toContain("MFAadminstotp"));
    expect(((await byId("sec-mfa-policy")) as HTMLSelectElement).title).toContain("Recorded only");
  });

  it("has the three prototype tabs, in the URL, and no Network, History or Emergency stop tabs", async () => {
    setup();
    mount();
    await byId("sec-sso-domain");
    expect(Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.textContent)).toEqual(["Authentication", "Sessions2", "Sign-in log2"]);
    fireEvent.click(await byId("sec-tab-sessions"));
    expect(window.location.search).toContain("tab=sessions");
    await byId("sec-ses-rv-s2");
  });

  it("stacks section 1 Sign-in policy and section 2 Restore needs two people, with the network and stop sections below", async () => {
    setup({ "GET /api/v1/stops": () => ({ body: { items: [] } }) });
    mount();
    await byId("sec-policy");
    expect(Array.from(document.querySelectorAll("#sec-tab-panel .panel-title")).map((t) => t.textContent).slice(0, 2)).toEqual(["Sign-in policy", "Restore needs two people"]);
    await byId("sec-dom-form");
    expect(text()).toContain("partner.example");
    expect(text()).toContain("docs.example.com");
    await byId("sec-stop-kill");
    expect(((await byId("sec-ip")) as HTMLTextAreaElement).value).toBe("10.0.0.0/8");
  });

  it("saves the whole policy form with one Save, each changed setting as its own versioned PATCH", async () => {
    let v = 3;
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: ++v } }) });
    mount();
    fireEvent.change(await byId("sec-hours"), { target: { value: "8" } });
    fireEvent.change(await byId("sec-mfa-policy"), { target: { value: "all" } });
    fireEvent.click(await byId("sec-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls).map((c) => [c.body.path, c.body.value])).toEqual([["mfa.policy", "all"], ["sessionHours", 8]]);
    expect(writes(calls).map((c) => c.ifMatch)).toEqual(["3", "4"]);
  });

  it("refuses an invalid form with the prototype messages and writes nothing", async () => {
    const calls = setup();
    mount();
    fireEvent.change(await byId("sec-sso-domain"), { target: { value: "nodot" } });
    fireEvent.change(await byId("sec-hours"), { target: { value: "0" } });
    fireEvent.change(await byId("sec-idle"), { target: { value: "2" } });
    fireEvent.change(await byId("sec-ip"), { target: { value: "not-a-cidr" } });
    fireEvent.click(await byId("sec-save"));
    await waitFor(() => expect(text()).toContain("Enter a domain like acme.dev."));
    expect(text()).toContain("Session length (hours) must be at least 1.");
    expect(text()).toContain("Idle timeout (minutes) must be at least 5.");
    expect(text()).toContain("Each line must be a CIDR such as 10.0.0.0/8.");
    expect(writes(calls)).toHaveLength(0);
  });

  it("lists sessions with Person, Device, Method, Started, Last seen, a red revoked chip, search and a confirmation before Revoke", async () => {
    const calls = setup({ "DELETE /api/v1/sessions/s2": () => ({ body: { ok: true, msg: "Revoked." } }) });
    mount();
    fireEvent.click(await byId("sec-tab-sessions"));
    await byId("sec-ses-rv-s2");
    expect(Array.from(document.querySelectorAll("#sec-ses-table th")).map((t) => t.textContent?.replace(/[↑↓]/g, ""))).toEqual(["Person", "Device", "Method", "Started", "Last seen", ""]);
    expect(document.querySelector("#sec-ses-table .chip.bad")?.textContent).toBe("revoked");
    expect(text()).toContain("3 sessions");
    fireEvent.change(document.querySelector("#sec-ses-q") as HTMLElement, { target: { value: "zzz" } });
    await waitFor(() => expect(text()).toContain("0 of 3 sessions"));
    await byId("sec-ses-clear");
    fireEvent.click(await byId("sec-ses-clear"));
    fireEvent.click(await byId("sec-ses-rv-s2"));
    expect(writes(calls)).toHaveLength(0);
    await waitFor(() => expect(text()).toContain("Revoke this session?"));
    expect(text()).toContain("is signed out on Chrome.");
    fireEvent.click(await byId("sec-ses-ok"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
  });

  it("filters the sign-in log by outcome and search, with Account first after When, and reads Reason", async () => {
    setup();
    mount();
    fireEvent.click(await byId("sec-tab-signins"));
    await waitFor(() => expect(text()).toContain("mallory@evil.test"));
    expect(Array.from(document.querySelectorAll("#sec-hist-table th")).map((t) => t.textContent?.replace(/[↑↓]/g, ""))).toEqual(["When", "Account", "Method", "Device", "Outcome", "Reason"]);
    expect(text()).toContain("Domain not allowed");
    fireEvent.change(await byId("sec-hist-f-outcome"), { target: { value: "success" } });
    await waitFor(() => expect(text()).not.toContain("mallory@evil.test"));
    expect(text()).toContain("1 of 2 sign-ins");
    expect(window.location.search).toContain("go=success");
  });

  it("shows an empty sign-in history as zero rows rather than a blank panel", async () => {
    setup({ "GET /api/v1/signins": () => ({ body: [] }) });
    mount();
    fireEvent.click(await byId("sec-tab-signins"));
    await waitFor(() => expect(text()).toContain("Nothing here yet"));
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
    fail = false;
    fireEvent.click(await byId("sec-error-retry"));
    await byId("sec-sso-domain");
  });

  it("says the settings are not visible when the viewer holds neither security.manage nor policy.view", async () => {
    const calls = setup({}, ["security.manage", "policy.view"]);
    mount();
    const hidden = await byId("sec-no-access");
    expect(hidden.textContent).toContain("No access to this sheet");
    expect(hidden.textContent).toContain("Back to Home");
    fireEvent.click(await byId("sec-home"));
    expect(window.location.hash).toBe("#home");
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
    const save = await byId("sec-save");
    await waitFor(() => expect(document.querySelector(".sec-lock .lock-note")).toBeTruthy());
    expect(document.querySelector(".lock-note")?.textContent).toContain("Read-only for you");
    expect(locked(save)).toBe(true);
    for (const id of ["sec-sso-provider", "sec-sso-domain", "sec-sso-enforced", "sec-gh", "sec-hours", "sec-idle", "sec-ip", "sec-two", "sec-kill-stepup"]) {
      expect(locked(await byId(id))).toBe(true);
    }
    fireEvent.click(await byId("sec-sso-enforced"));
    fireEvent.click(save);
    await byId("sec-dom-add");
    for (const id of ["sec-dom-new", "sec-dom-add", "sec-dom-rm-partner_example", "sec-rh-add", "sec-rh-rm-docs_example_com", "sec-chatcap-save"]) {
      expect(locked(await byId(id))).toBe(true);
    }
    expect(writes(calls)).toHaveLength(0);
  });

  it("lets a manager toggle a setting with the version they read, and guards the domain they signed in with", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-gh"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "PATCH", path: "/api/v1/security", body: { path: "githubLogin", value: true } });
    const own = await byId("sec-dom-rm-acme_dev");
    expect(locked(own)).toBe(true);
    expect(own.getAttribute("data-reason")).toMatch(/lock you out/);
    expect(locked(await byId("sec-dom-rm-partner_example"))).toBe(false);
  });

  it("sends the version it read with a setting change", async () => {
    const calls = setup({ "PATCH /api/v1/security": () => ({ body: { ok: true, msg: "Saved.", version: 4 } }) });
    mount();
    fireEvent.click(await byId("sec-gh"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.ifMatch).toBe("3");
  });

  it("shows a failed sign-in history read on the history tab while the rest of the page works", async () => {
    setup({ "GET /api/v1/signins": () => ({ status: 500, body: { ok: false, msg: "History is unavailable." } }) });
    mount();
    await byId("sec-sso-domain");
    fireEvent.click(await byId("sec-tab-signins"));
    const err = await byId("sec-history-error");
    expect(err.textContent).toContain("History is unavailable.");
  });

  it("keeps the domain the viewer signed in with locked even for a manager, with the reason", async () => {
    const calls = setup();
    mount();
    const own = await byId("sec-dom-rm-acme_dev");
    expect(locked(own)).toBe(true);
    expect(own.getAttribute("data-reason")).toMatch(/lock you out/);
    fireEvent.click(own);
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("Security screen: emergency stop section", () => {
  it("offers the factory kill with who may do it, lists the stops in force, and warns when a restore could not be approved", async () => {
    setup({ "GET /api/v1/people": () => ({ body: [PEOPLE[0]] }), "GET /api/v1/stops": () => ({ body: { items: [{ id: "project:payments", row: "r1", scope: "project", mode: "halt", reason: "Flaky tests", inFlight: null, by: "p-asha", at: NOW - 60000, version: 1, fencing: 1 }] } }) });
    mount();
    expect(locked(await byId("sec-stop-kill"))).toBe(false);
    expect((await byId("sec-stop-warn")).textContent).toContain("a restore could not be approved");
    await waitFor(() => expect(document.getElementById("sec-stops-table")?.textContent).toContain("Flaky tests"));
    expect(text()).toContain("Needs two different Factory Admins and a fresh sign-in.");
  });

  it("locks the kill with the server's reason when kill.factory is denied", async () => {
    setup({ "GET /api/v1/stops": () => ({ body: { items: [] } }) }, ["kill.factory"]);
    mount();
    const kill = await byId("sec-stop-kill");
    await waitFor(() => expect(locked(kill)).toBe(true));
    expect(kill.getAttribute("data-reason")).toContain("No role holds kill.factory");
    await waitFor(() => expect(text()).toContain("Nothing is stopped right now."));
  });

  it("says why a read-only role cannot save when Save settings is clicked, and marks required fields '(required)'", async () => {
    setup({}, ["security.manage"]);
    mount();
    const save = await byId("sec-save");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("label[for=sec-sso-domain]")?.textContent).toBe("Email domain (required)");
    expect(document.querySelector("label[for=sec-sso-domain] .field-req")).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(document.body.textContent).toContain("Your role is read-only for this action."));
  });

  it("opens the Sessions tab from the prototype deep link #/security?tab=sessions", async () => {
    window.history.replaceState(null, "", "/#/security?tab=sessions");
    setup();
    mount();
    await byId("sec-ses-table");
    window.history.replaceState(null, "", "/");
  });

  it("writes Sessions Started and Last seen with one unit, like the prototype", async () => {
    window.history.replaceState(null, "", "/?tab=sessions");
    setup();
    mount();
    const t = await byId("sec-ses-table");
    expect(t.textContent).toContain("1h ago");
    expect(t.textContent).not.toMatch(/\dh \d+m ago/);
    window.history.replaceState(null, "", "/");
  });
});
