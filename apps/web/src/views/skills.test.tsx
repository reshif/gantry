import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import SkillsView, { skillsUi } from "./skills";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any }

const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman")];
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance");
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.5", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

const skill = (id: string, name: string, o: object = {}) => ({
  id, name, desc: `${name} purpose.`, when: "When needed.", owner: "p-asha", body: "Do the thing.", resources: ["checklist.md"], version: "1.2.0", projects: "all",
  versions: [{ v: "1.0.0", at: 1, by: "p-asha", note: "Created" }, { v: "1.2.0", at: 2, by: "p-asha", note: "Tightened" }], coverage: { suite: "s1", cases: 10, pass: 9 }, ...o,
});
const SKILLS = [skill("sk-review", "Code review"), skill("sk-docs", "Docs writer", { coverage: { suite: null, cases: 0, pass: 0 }, projects: ["payments"] })];
const AGENTS = [{ id: "ag-build", name: "Build agent", station: "build", model: "claude-sonnet-5-5", fallbacks: [], initials: "B", skills: ["sk-review"], projects: "all", suite: "s1", versions: [], rev: 1, suiteName: "Build suite", threshold: 0.8 }];

const BASE: Record<string, Handler> = {
  "GET /api/v1/me": () => ({ body: ME }),
  "GET /api/v1/people": () => ({ body: PEOPLE }),
  "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
  "GET /api/v1/agents": () => ({ body: AGENTS }),
  "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
  "GET /api/v1/learning/proposals": () => ({ body: [] }),
  "GET /api/v1/skills": () => ({ body: SKILLS }),
};

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = { ...BASE, ...extra };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body });
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
/** The library, or one skill's own page (`#skills/<id>`) when an id is given. */
function mount(skill?: string) {
  window.location.hash = skill ? `#skills/${skill}` : "#skills";
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><SkillsView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const text = () => document.body.textContent ?? "";
const locked = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled;

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  Object.assign(skillsUi, { sel: null, tab: "def", draft: null, draftFor: null, note: "", q: "", filter: "all" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skills screen", () => {
  it("shows the library with versions, usage and eval coverage, and the first skill's definition", async () => {
    setup();
    mount();
    const row = await byId("sk-row-sk-review");
    expect(row.textContent).toContain("Code review");
    expect(row.textContent).toContain("v1.2.0");
    expect(row.textContent).toContain("9/10");
    expect((await byId("sk-row-sk-docs")).textContent).toContain("none");
    expect(text()).toContain("Skills2");
    expect(text()).toContain("Pass rate90%");
    expect(locked(await byId("sk-new"))).toBe(false);
    fireEvent.click(row);
    expect(window.location.hash).toBe("#skills/sk-review");
    cleanup();
    mount("sk-review");
    expect(((await byId("sk-name")) as HTMLInputElement).value).toBe("Code review");
    expect(document.getElementById("sk-save")?.textContent).toContain("Save as v1.3.0");
  });

  it("filters to unused skills and says when none match", async () => {
    setup();
    mount();
    await byId("sk-row-sk-review");
    fireEvent.click(await byId("sk-view-unused"));
    await waitFor(() => expect(document.getElementById("sk-row-sk-review")).toBeNull());
    expect(document.getElementById("sk-row-sk-docs")).toBeTruthy();
    fireEvent.change(await byId("sk-search"), { target: { value: "zzz" } });
    expect((await byId("sk-lib")).textContent).toContain("No skills match");
  });

  it("shows the empty state when the library has no skills, and still offers a new skill", async () => {
    setup({ "GET /api/v1/skills": () => ({ body: [] }) });
    mount();
    await waitFor(() => expect(text()).toContain("No skills yet"));
    expect(text()).toContain("Create the first skill.");
    expect(locked(await byId("sk-new"))).toBe(false);
  });

  it("shows the failure with a retry, not a blank screen, and recovers", async () => {
    let fail = true;
    setup({ "GET /api/v1/skills": () => (fail ? { status: 500, body: { ok: false, msg: "The skill store is down." } } : { body: SKILLS }) });
    mount();
    const err = await byId("skills-error");
    expect(err.textContent).toContain("Couldn't load skills");
    expect(err.textContent).toContain("The skill store is down.");
    fail = false;
    fireEvent.click(await byId("skills-error-retry"));
    await byId("sk-row-sk-review");
  });

  it("says the library is not visible on a 403", async () => {
    setup({ "GET /api/v1/skills": () => ({ status: 403, body: { ok: false, msg: "Needs Skills access." } }) });
    mount();
    const hidden = await byId("skills-hidden");
    expect(hidden.textContent).toContain("Not visible to you");
    expect(hidden.textContent).toContain("Needs Skills access.");
  });

  it("saves an edit as a new version with the version it read and the change note", async () => {
    const calls = setup({ "PATCH /api/v1/skills/sk-review": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount("sk-review");
    fireEvent.change(await byId("sk-desc"), { target: { value: "A sharper purpose." } });
    fireEvent.change(await byId("sk-note"), { target: { value: "Clarified" } });
    fireEvent.click(await byId("sk-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const w = writes(calls)[0]!;
    expect(w.path).toBe("/api/v1/skills/sk-review");
    expect(JSON.stringify(w.body)).toContain("A sharper purpose.");
    expect(JSON.stringify(w.body)).toContain("Clarified");
  });

  it("makes the skill read-only with the reason when the viewer may not edit skills, and sends nothing", async () => {
    const calls = setup({}, ["skill.edit", "agent.edit"]);
    mount("sk-review");
    const save = await byId("sk-save");
    await waitFor(() => expect(locked(save)).toBe(true));
    expect(save.getAttribute("data-reason")).toMatch(/Factory Admin/);
    for (const id of ["sk-name", "sk-desc", "sk-when", "sk-body", "sk-res", "sk-note"]) expect(((await byId(id)) as HTMLInputElement).disabled).toBe(true);
    expect(locked(await byId("sk-discard"))).toBe(true);
    expect(document.querySelector(".lock-note")?.textContent).toContain("Read-only for you");
    fireEvent.click(save);
    fireEvent.click(await byId("sk-tab-projects"));
    expect(locked(await byId("sk-proj-all"))).toBe(true);
    fireEvent.click(await byId("sk-tab-agents"));
    expect(locked(await byId("sk-att-ag-build"))).toBe(true);
    cleanup();
    mount();
    await waitFor(() => expect(locked(document.getElementById("sk-new")!)).toBe(true));
    expect(writes(calls)).toHaveLength(0);
  });
});
