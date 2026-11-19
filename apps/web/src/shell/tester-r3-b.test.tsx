/** Tester round 3, batch B: palette finds spend and gates, old addresses redirect, the Inbox scope is named, the record's criteria read the Brief, the narrow work order card. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import App from "../App";
import { canBatcher } from "../api/can";
import { reloadPrefs } from "../lib/prefs";
import { WoActions } from "../views/work/WoActions";
import { CriteriaPanel } from "../views/dossier/Panels";
import { waitingWo } from "../views/traveler/testkit";
import { mockApi as mockViewApi, mount, resetApp } from "../views/floor/testkit";

type Json = unknown;
const person = { id: "p-x", name: "Asha Raman", title: "Head", email: "asha@acme.dev", teams: ["platform"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "asha", away: null };
const project = (id: string) => ({ id, name: id === "payments" ? "Payments Platform" : id, key: id.slice(0, 3).toUpperCase(), status: "active", halted: null, killed: null });
const meBody = () => ({ person, session: { id: "s1", person: "p-x", method: "sso", device: "d", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "csrf-1", projects: [project("payments"), project("risk")], factory: { killed: null }, config: { demoAccounts: false } });

function mockApi(routes: Record<string, (url: string, init?: RequestInit) => { status?: number; body: Json }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0] ?? url;
    if (path === "/api/v1/can") {
      const checks = (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks;
      return new Response(JSON.stringify({ results: checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
    }
    const h = routes[path];
    const r = h ? h(url, init) : { status: 404, body: { ok: false, msg: "none" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
}
class FakeES { static instances: FakeES[] = []; onopen = null; onerror = null; constructor(public url: string) { FakeES.instances.push(this); } addEventListener() {} close() {} }

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeES);
  window.location.hash = "";
  try { localStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  canBatcher.clear();
  resetApp();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const waiting = { approvals: [{ wo: "WO-1", gate: "G2", project: "payments" }, { wo: "WO-2", gate: "G2", project: "risk" }], conversations: [] };
const api = () => mockApi({ "/api/v1/me": () => ({ body: meBody() }), "/api/v1/home": () => ({ body: { approvals: [], conversations: [], badges: {}, sections: { waiting } } }) });

describe("T-45: spend and gates are findable and old addresses land somewhere real", () => {
  it("the palette finds Spend (Budget tab) and Gates (Inbox, Approvers tab)", async () => {
    api();
    window.location.hash = "#/home";
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    act(() => { fireEvent.keyDown(document, { key: "k", ctrlKey: true }); });
    const input = await screen.findByPlaceholderText("Jump to a screen, work order, agent, repo or action…");
    fireEvent.change(input, { target: { value: "spend" } });
    await waitFor(() => expect(Array.from(document.querySelectorAll("#palette-list .pal-label")).map((l) => l.textContent)).toContain("Spend and budget"));
    fireEvent.change(input, { target: { value: "gates" } });
    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll("#palette-list .pal-label")).map((l) => l.textContent);
      expect(labels).toContain("Gates and approvers");
      expect(labels).toContain("Inbox");
    });
  });

  it("#/spend opens the project's Budget tab and #/gates opens the Inbox, instead of Sheet not found", async () => {
    api();
    window.location.hash = "#/spend";
    render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/project-config?tab=budget"));
    expect(screen.queryByText("Sheet not found")).toBeNull();
    window.location.hash = "#/gates";
    await waitFor(() => expect(window.location.hash).toBe("#inbox"));
    expect(screen.queryByText("Sheet not found")).toBeNull();
  });

  it("a name that is no screen and no alias still says Sheet not found", async () => {
    api();
    window.location.hash = "#/nonexistent";
    render(<App />);
    expect(await screen.findByText("Sheet not found")).toBeTruthy();
  });
});

describe("T-46: the Inbox count names its scope", () => {
  it("the nav badge says which projects it counts", async () => {
    api();
    window.location.hash = "#/home";
    render(<App />);
    const nav = within(await screen.findByRole("navigation", { name: "Primary" }));
    await waitFor(() => expect(nav.getAllByTitle(/waiting for you in (all projects|Payments Platform)/).length).toBeGreaterThan(0));
  });
});

describe("T-43: Acceptance criteria read the Brief when Verify has not reported", () => {
  it("lists the Brief's criteria instead of 'None recorded yet'", () => {
    const wo = { ...waitingWo, criteria: [], brief: { goal: "g", scopeIn: [], scopeOut: [], ac: ["New behaviour covered by tests", "No change to the public API"], risks: [], decisions: [], open: [] } } as never;
    mount(<CriteriaPanel wo={wo} criteria={[]} />);
    expect(screen.getByText("New behaviour covered by tests")).toBeTruthy();
    expect(screen.getByText("No change to the public API")).toBeTruthy();
    expect(screen.queryByText("None recorded yet.")).toBeNull();
  });
  it("still says none are recorded when neither Verify nor the Brief has any", () => {
    mount(<CriteriaPanel wo={{ ...waitingWo, criteria: [], brief: { goal: "g", scopeIn: [], scopeOut: [], ac: [], risks: [], decisions: [], open: [] } } as never} criteria={[]} />);
    expect(screen.getByText("None recorded yet.")).toBeTruthy();
  });
});

describe("T-42: the Work orders card on a phone", () => {
  it("the Approve button is labelled in full, without an ellipsis", () => {
    mockViewApi({});
    mount(<WoActions wo="WO-1" project="payments" needs={{ kind: "gate", text: "Approve", mine: true } as never} />);
    return waitFor(() => expect(screen.getByRole("button", { name: /Approve for WO-1/ }).textContent).toBe("Approve"));
  });
  it("at phone width a row is a compact flex card with the labels of the short cells hidden", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/views/workorders.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 720px\) \{[^@]*\.wo-table table\.tbl\.cards tr \{ display: flex; flex-wrap: wrap/);
    expect(css).toMatch(/td:not\(\[data-label="Needs"\]\)::before \{ display: none; \}/);
    expect(css).toMatch(/td:last-child \.wo-acts \{ flex-direction: row/);
  });
});

describe("T-47 / T-48: polish", () => {
  const src = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");
  it("the archive card no longer prints the permission key as copy", () => {
    expect(src("views/project-config/misc.tsx")).not.toContain(">project.archive<");
  });
  it("an integration card names a setting by its field label and shows a boolean as Yes or No", () => {
    const t = src("views/integrations/Tabs.tsx");
    expect(t).toContain('t.fields.find((f) => f.key === k)?.label ?? k');
    expect(t).toContain('v ? "Yes" : "No"');
  });
  it("the Audit time does not wrap onto a second line, and the Floor ticker counts what the Parts list counts", () => {
    expect(src("views/audit.tsx")).toMatch(/whiteSpace: "nowrap" \}\}>\{dayMon\(e\.at\)\}/);
    expect(src("views/floor.tsx")).toContain("`of ${model.all.filter((b) => b.w.bay !== \"declined\").length}`");
  });
  it("Record > Activity: the Timeline panel is not stretched to the Conversation column, and the Brief has panel chrome", () => {
    expect(src("views/dossier/Dossier.tsx")).toContain('className="cols w21 dz-act"');
    expect(src("styles/views/dossier.css")).toMatch(/\.dz-act \{ align-items: start; \}/);
    expect(src("styles/views/wosession.css")).toMatch(/\.dz-conv \.wos-brief \{ border: 1px solid/);
  });
});
