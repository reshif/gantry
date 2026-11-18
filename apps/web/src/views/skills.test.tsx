import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient, invalidateSlices } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import SkillsView, { skillsUi } from "./skills";
import { clearDrafts } from "../lib/useDraft";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers?: Record<string, string>; ifMatch?: string }

const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman")];
const project = (id: string, name: string) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1 });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance");
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "10.0.0.5", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

const skill = (id: string, name: string, o: object = {}) => ({
  id, name, desc: `${name} purpose.`, when: "When needed.", owner: "p-asha", body: "Do the thing.", resources: ["checklist.md"], version: "1.2.0", rev: 4, projects: "all",
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
    calls.push({ method, path: u.pathname, body, headers: (init?.headers ?? {}) as Record<string, string>, ifMatch: (init?.headers as Record<string, string> | undefined)?.["If-Match"] });
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
  clearDrafts();
  Object.assign(skillsUi, { sel: null, tab: "def", note: "", q: "", filter: "all" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Skills screen", () => {
  it("shows the library in the prototype's columns, opens the drawer from the name and the page from the drawer", async () => {
    setup();
    mount();
    const row = await byId("sk-row-sk-review");
    expect(row.textContent).toContain("Code review");
    expect(row.textContent).toContain("1.2.0");
    expect(locked(await byId("sk-new"))).toBe(false);
    fireEvent.click(row.querySelector("a.sk-name")!);
    expect(window.location.hash).not.toContain("sk-review");
    expect((await byId("sk-drawer")).textContent).toContain("Skill \u00b7 v1.2.0");
    fireEvent.click(await byId("sk-drawer-edit"));
    expect(window.location.hash).toBe("#skills/sk-review");
    cleanup();
    mount("sk-review");
    expect(((await byId("sk-name")) as HTMLInputElement).value).toBe("Code review");
    expect(document.getElementById("sk-save")?.textContent).toContain("Save as v1.3.0");
  });

  it("filters by search and says Nothing matches with a Clear filters button", async () => {
    setup();
    mount();
    await byId("sk-row-sk-review");
    fireEvent.change(await byId("sk-search"), { target: { value: "zzz" } });
    expect((await byId("sk-lib")).textContent).toContain("Nothing matches");
    fireEvent.click(await byId("sk-empty-clear"));
    await waitFor(() => expect(document.getElementById("sk-row-sk-review")).not.toBeNull());
  });

  it("shows the empty state when the library has no skills, and still offers a new skill", async () => {
    setup({ "GET /api/v1/skills": () => ({ body: [] }) });
    mount();
    await waitFor(() => expect(text()).toContain("Nothing here yet"));
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
    expect(w.ifMatch).toBe("4");
    expect(JSON.stringify(w.body)).toContain("A sharper purpose.");
    expect(JSON.stringify(w.body)).toContain("Clarified");
  });

  it("keeps a colleague's change to a field this person did not touch, and sends only the touched field with the new revision", async () => {
    let live = skill("sk-review", "Code review", { rev: 1 });
    const calls = setup({ "GET /api/v1/skills": () => ({ body: [live] }), "PATCH /api/v1/skills/sk-review": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount("sk-review");
    fireEvent.change(await byId("sk-name"), { target: { value: "Code review v2" } });
    live = skill("sk-review", "Code review", { rev: 2, desc: "A colleague rewrote this." });
    invalidateSlices(["skills"]);
    await waitFor(() => expect(((document.getElementById("sk-desc")) as HTMLTextAreaElement).value).toBe("A colleague rewrote this."));
    expect(document.getElementById("sk-conflict")).toBeNull();
    expect(((await byId("sk-name")) as HTMLInputElement).value).toBe("Code review v2");
    fireEvent.click(await byId("sk-save"));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    const w = writes(calls)[0]!;
    expect(Object.keys(w.body.patch)).toEqual(["name"]);
    expect(String(w.headers?.["If-Match"])).toBe("2");
  });

  it("stops with a conflict banner when the same field changed on both sides, and sends nothing until a choice is made", async () => {
    let live = skill("sk-review", "Code review", { rev: 1 });
    const calls = setup({ "GET /api/v1/skills": () => ({ body: [live] }), "PATCH /api/v1/skills/sk-review": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount("sk-review");
    fireEvent.change(await byId("sk-desc"), { target: { value: "Mine." } });
    live = skill("sk-review", "Code review", { rev: 2, desc: "Theirs." });
    invalidateSlices(["skills"]);
    const banner = await byId("sk-conflict");
    expect(banner.getAttribute("role")).toBe("alert");
    fireEvent.click(await byId("sk-save"));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes(calls)).toHaveLength(0);
    fireEvent.click(await byId("sk-conflict-theirs"));
    await waitFor(() => expect(((document.getElementById("sk-desc")) as HTMLTextAreaElement).value).toBe("Theirs."));
    expect(document.getElementById("sk-conflict")).toBeNull();
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

  it("locks attaching to an agent when the viewer may edit skills but not agents, and sends nothing", async () => {
    const calls = setup({}, ["agent.edit"]);
    mount("sk-review");
    expect(locked(await byId("sk-new"))).toBe(false);
    fireEvent.click(await byId("sk-tab-agents"));
    const att = await byId("sk-att-ag-build");
    await waitFor(() => expect(locked(att)).toBe(true));
    fireEvent.click(att);
    expect(writes(calls)).toHaveLength(0);
  });

  it("locks the definition but not the library when the viewer may edit agents but not skills", async () => {
    const calls = setup({}, ["skill.edit"]);
    const lib = mount();
    expect(locked(await byId("sk-new"))).toBe(true);
    lib.unmount();
    mount("sk-review");
    const save = await byId("sk-save");
    await waitFor(() => expect(locked(save)).toBe(true));
    expect(((await byId("sk-body")) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(writes(calls)).toHaveLength(0);
  });

  it("shows what the version on the floor runs next to the draft attachment, and says when they differ", async () => {
    const drift = [{ ...AGENTS[0], version: "1.4.0", skills: [], liveSkills: [{ id: "sk-review", version: "1.2.0" }] }];
    setup({ "GET /api/v1/agents": () => ({ body: drift }) });
    mount("sk-review");
    fireEvent.click(await byId("sk-tab-agents"));
    const live = await byId("sk-live-ag-build");
    expect(live.textContent).toContain("Live 1.4.0 · skill v1.2.0");
    expect(live.textContent).toContain("Detached in draft: still runs until the next version is promoted.");
    expect(((await byId("sk-att-ag-build")) as HTMLInputElement).checked).toBe(false);
    cleanup();
    setup({ "GET /api/v1/agents": () => ({ body: [{ ...AGENTS[0], version: "1.4.0", skills: ["sk-review"], liveSkills: [] }] }) });
    mount("sk-review");
    fireEvent.click(await byId("sk-tab-agents"));
    const l2 = await byId("sk-live-ag-build");
    expect(l2.textContent).toContain("Not used by the live version");
    expect(l2.textContent).toContain("Attached in draft only: runs after the next version is promoted.");
  });
});
