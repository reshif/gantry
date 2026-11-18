import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import { clearDrafts } from "../lib/useDraft";
import AgentsView from "./agents";
import SkillsView, { skillsUi } from "./skills";
import { resetRoster } from "./agents";
import { ui as agentsUi } from "./agents/kit";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const NOW = Date.now();
const person = (id: string, name: string) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2 });
const PEOPLE = [person("p-asha", "Asha Raman")];
const project = (id: string, name: string, key: string, regulated = false) => ({ id, name, key, status: "active", teams: ["payments"], owner: "p-asha", template: "t", regulated, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 0, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: `${name} overlay text.`, version: 3 });
const PAYMENTS = project("payments", "Payments Platform", "PAY");
const RISK = project("risk", "Risk and Compliance", "RSK", true);
const elig = (ok: boolean, text: string, extra: object = {}) => ({ ok, text, score: ok ? 0.9 : null, suite: "SUITE-BUILD", threshold: 0.85, needs: ok ? "" : "A passing run of SUITE-BUILD", ...extra });
const ver = (v: string, o: object = {}) => ({ v, at: NOW - 86_400_000, note: `Note ${v}`, diff: `~ ${v} diff`, suiteScore: 0.9, live: false, rc: false, snapshot: null, eligibility: elig(true, "Eligible: 90% vs 85% on SUITE-BUILD"), ...o });
const BUILD = {
  id: "ag-build", name: "Builder", station: "build", model: "claude-opus-5-5", fallbacks: ["claude-sonnet-5-5"], version: "2.6.1", status: "active", autonomy: "gate",
  tools: { readRepo: true, writeBranch: true, runTests: true, openPR: true, merge: false, postSlack: true, sendEmail: false, readSecrets: false }, skills: ["sk-a", "sk-b"], mcp: ["mcp-docs"], stations: ["build"], projects: "all",
  budget: 12, guardrails: { paths: ["infra/prod/**"], maxDiff: 800 }, suite: "SUITE-BUILD", instructions: "Implement the approved plan on a branch.", overrides: { risk: { model: "claude-sonnet-5-5" } },
  versions: [
    ver("2.5.0", { snapshot: JSON.stringify({ model: "claude-opus-5-5", skills: ["sk-a"] }) }),
    ver("2.6.1", { live: true }),
    ver("2.7.0-rc1", { rc: true, suiteScore: 0, eligibility: elig(false, "No run of SUITE-BUILD yet") }),
    ver("2.8.0-rc1", { rc: true, eligibility: elig(true, "Eligible: 91% vs 85% on SUITE-BUILD") }),
  ],
  spark: [0.8, 0.82, 0.85, 0.84, 0.86, 0.9, 0.88], spend7d: 612, initials: "B", evalScore: 0.8, rev: 7, suiteName: "Builder golden set", threshold: 0.85, running: 2,
};
const REVIEW = { ...BUILD, id: "ag-review", name: "Reviewer", station: "review", model: "claude-sonnet-5-5", fallbacks: [], version: "1.0.0", status: "paused", skills: [], mcp: [], stations: ["review"], suite: "SUITE-REVIEW", versions: [ver("1.0.0", { live: true })], evalScore: 0.95, rev: 1, running: 0, spark: [], spend7d: 40 };
const AGENTS = [BUILD, REVIEW];
const skill = (id: string, name: string, o: object = {}) => ({ id, name, desc: `${name} desc`, when: `When ${name}.`, owner: "p-asha", body: `${name} body`, resources: ["checklist.md"], version: "1.2.0", projects: "all", versions: [{ v: "1.0.0", at: NOW - 9e8, by: "p-asha", note: "First" }, { v: "1.2.0", at: NOW - 1e8, by: "p-asha", note: "Tightened" }], coverage: { suite: "SUITE-BUILD", cases: 10, pass: 9 }, rev: 4, ...o });
const SKILLS = [skill("sk-a", "Test design"), skill("sk-b", "Security review", { coverage: { suite: null, cases: 0, pass: 0 }, projects: ["payments"], rev: 2 }), skill("sk-c", "Release notes", { coverage: { suite: null, cases: 4, pass: 2 } })];
const VENDORS = [{ id: "anthropic", name: "Anthropic", connected: true, models: [{ id: "claude-opus-5-5", name: "Opus 5.5", enabled: true }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5", enabled: true }, { id: "off-model", name: "Off model", enabled: false }] }];
const POLICIES = [{ id: "POL-112", name: "No autonomy on regulated", effect: "deny", enabled: true, roles: ["*"], actions: [], where: {}, when: null, oncallOnly: false }];
const MCP = [{ id: "mcp-docs", name: "Docs wiki", transport: "http", url: "https://x", auth: "Bearer", authMask: "••", health: "healthy", sensitivity: "internal", writeGate: true, tools: [{ name: "search", write: false, allowed: true }, { name: "edit", write: true, allowed: true }], projects: "all", repos: "all", agents: ["ag-build"], stations: "all" }];
const REPOS = [{ id: "payments-api", name: "payments-api", project: "payments", guidelines: "Use pnpm.", version: 5 }];
const layers = [
  { key: "base", name: "Factory base", version: 4, hash: "a", text: "Base rules." },
  { key: "project", name: "Project overlay", version: 1, hash: "b", text: "Payments Platform overlay text." },
  { key: "agent", name: "Agent", version: 2, hash: "c", text: "Implement the approved plan on a branch." },
  { key: "repo", name: "Repo guidelines (Gantry)", version: null, hash: "d", text: "Use pnpm.", commit: "a".repeat(40) },
];
const sections = [
  ...layers.map((l) => ({ key: l.key, title: l.name, source: "layer", text: l.text, words: 3 })),
  { key: "skill:sk-a", title: "Skill: Test design v1.2.0", source: "skill", text: "Test design body, in full.", words: 5 },
  { key: "station-tools", title: "Station tools", source: "runner", text: "## Showing your work: the gantry tools", words: 6 },
  { key: "result", title: "Result format", source: "runner", text: "End with one fenced json block.", words: 6 },
];
const EFFECTIVE = { agent: "ag-build", version: "2.6.1", live: true, draft: false, project: { id: "payments", name: "Payments Platform" }, repo: { id: "payments-api", name: "payments-api" }, text: "x", hash: "e".repeat(64), promptHash: "f".repeat(64), sections, handoff: { first: "Station: <the station the agent works>", json: ["workOrder (id, title, class)"] }, words: 10, tokens: 20, layers, skills: [] };
const ME = { person: PEOPLE[0], session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: ME }),
    "GET /api/v1/people": () => ({ body: PEOPLE }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
    "GET /api/v1/agents": () => ({ body: AGENTS }),
    "GET /api/v1/agents/suites": () => ({ body: [{ id: "SUITE-BUILD", name: "Builder golden set", station: "build", agent: "ag-build", threshold: 0.85 }, { id: "SUITE-REVIEW", name: "Reviewer golden set", station: "review", agent: "ag-review", threshold: 0.85 }] }),
    "GET /api/v1/agents/ag-build/effective": () => ({ body: EFFECTIVE }),
    "GET /api/v1/skills": () => ({ body: SKILLS }),
    "GET /api/v1/instructions/base": () => ({ body: { base: "Base rules.", baseVersion: 4 } }),
    "GET /api/v1/vendors": () => ({ body: VENDORS }),
    "GET /api/v1/routing": () => ({ body: { defaultModel: "claude-sonnet-5-5", overrides: {}, fallback: [], rules: [] } }),
    "GET /api/v1/policies": () => ({ body: POLICIES }),
    "GET /api/v1/mcp/servers": () => ({ body: MCP }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/projects/payments/repos": () => ({ body: REPOS }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [] }),
    "GET /api/v1/audit": () => ({ body: { items: [{ id: 1, at: NOW, actor: "p-asha", action: "agent.edit", target: "Builder: budget", where: "factory", project: null, category: "agents", outcome: "ok", via: "web", before: "12", after: "14", entity: { type: "agent", id: "ag-build" } }], next: null } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: hdr, query: u.searchParams });
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
function mount(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider>{el}</OverlayProvider></QueryClientProvider>);
}
/** An agent's own page: `#agents/<id>`. */
function mountAgent(id = "ag-build") {
  window.location.hash = `#agents/${id}`;
  return mount(<AgentsView />);
}
const ok = (extra: object = {}) => ({ body: { ok: true, msg: "Done.", ...extra } });
const writes = (calls: Call[], method: string) => calls.filter((c) => c.method === method && c.path !== "/api/v1/can");
const TABS: Record<string, string> = { instructions: "instr", overrides: "proj" };
const tab = async (id: string) => { fireEvent.click(await byId(`ag-tab-${TABS[id] ?? id}`)); await waitFor(() => expect(document.getElementById(`ag-tab-${TABS[id] ?? id}`)!.getAttribute("aria-selected")).toBe("true")); };

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  clearDrafts();
  Object.assign(skillsUi, { q: "" });
  resetRoster();
  Object.assign(agentsUi, { sel: null, tab: "config", ctxProject: null, ctxRepo: null, newVer: "", newNote: "" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agents screen", () => {
  it("lists the roster in the Blueprint columns: plain name and station, raw model, version, eval, spend, lowercase status", async () => {
    setup();
    mount(<AgentsView />);
    const row = await byId("ag-row-ag-build");
    expect(row.textContent).toContain("Builder");
    expect(row.textContent).toContain("claude-opus-5-5");
    expect(row.textContent).not.toContain("+1");
    expect(row.textContent).toContain("v2.6.1");
    expect(row.textContent).not.toContain("candidate");
    expect(row.querySelector(".ag-below")).toBeNull();
    expect(row.textContent).toContain("80%");
    expect(row.textContent).toContain("$612");
    expect((await byId("ag-row-ag-review")).textContent).toContain("paused");
    expect(row.querySelector(".spark-area")).toBeNull();
    const head = document.getElementById("ag-stats")!.textContent!;
    expect(head).toContain("Agents2");
    expect(head).toContain("1 active");
    expect(head).toContain("On autopilot");
    expect(head).toContain("Need approval");
    expect(document.querySelector(".stat.info")!.textContent).toContain("Agents");
    expect(document.querySelector(".ph .eyebrow")!.textContent).toContain("All lines");
    // sortable: Agent, Model, Autonomy, Eval, Spend; not Status
    const sortable = [...document.querySelectorAll("#ag-roster thead th button")].map((b) => b.textContent!.replace(/[↕↑↓ ]/g, ""));
    expect(sortable).toEqual(["Agent", "Model", "Autonomy", "Eval", "Spend"]);
    expect(document.querySelector("#ag-roster .tfoot")!.textContent).toContain("1–2 of 2");
    expect(document.getElementById("ag-f-view")).toBeNull();
    expect(document.getElementById("agent-create")).toBeNull();
    expect([...document.querySelectorAll(".ph-actions .btn, .ph .actions .btn")].map((b) => b.textContent)).not.toContain("Create agent");
  });

  it("filters the roster by status, station and search, clears them, and opens an agent's own page from a row", async () => {
    setup();
    mount(<AgentsView />);
    await byId("ag-row-ag-build");
    expect(document.getElementById("ag-clear")).toBeNull();
    await waitFor(() => expect((document.getElementById("ag-f-station") as HTMLSelectElement).textContent).toContain("Build"));
    expect((document.getElementById("ag-f-station") as HTMLSelectElement).textContent).not.toContain("S5");
    fireEvent.change(document.getElementById("ag-f-status")!, { target: { value: "paused" } });
    await waitFor(() => expect(document.getElementById("ag-row-ag-build")).toBeNull());
    expect(document.getElementById("ag-row-ag-review")).not.toBeNull();
    fireEvent.click(document.getElementById("ag-clear")!);
    await waitFor(() => expect(document.getElementById("ag-row-ag-build")).not.toBeNull());
    fireEvent.change(document.getElementById("ag-search")!, { target: { value: "zzz" } });
    expect((await screen.findByText("Nothing matches these filters")).closest(".state")!.textContent).toContain("Loosen the search or clear the filters.");
    fireEvent.click(document.getElementById("ag-clear-empty")!);
    fireEvent.change(document.getElementById("ag-search")!, { target: { value: "build" } });
    await waitFor(() => expect(document.getElementById("ag-row-ag-review")).toBeNull());
    fireEvent.click(await byId("ag-row-ag-build"));
    expect(window.location.hash).toBe("#agents/ag-build");
  });

  it("shows one agent as the Blueprint page: breadcrumb, station purpose, four tiles, five tabs outside any panel, and says so when the agent is gone", async () => {
    setup();
    mountAgent();
    await byId("agent-detail");
    expect(document.querySelector(".ph .eyebrow")!.textContent).toBe("Agents/Builder");
    expect(document.querySelector(".ph .eyebrow a")!.getAttribute("href")).toBe("#agents");
    expect(document.querySelector("h1")!.textContent).toBe("Builder");
    expect(document.querySelector(".ph .sub")!.textContent).toMatch(/\S/);
    const tiles = document.getElementById("ag-detail-stats")!.textContent!;
    expect(tiles).toContain("Eval score");
    expect(tiles).toContain("v2.6.1");
    expect(tiles).toContain("Spend, 7d");
    expect(tiles).toContain("Autonomy");
    expect([...document.querySelectorAll("#agent-detail [role=tab]")].map((t) => t.textContent)).toEqual(["Configuration", "Instructions", "Skills and MCP3", "Per-project1", "Versions4"]);
    expect(document.querySelector(".ag-panel")).toBeNull();
    expect(document.getElementById("ag-evals")).toBeNull();
    expect(document.querySelector(".trust-strip")).toBeNull();
    // Identity (kv) and Tools side by side, then guardrail paths
    expect([...document.querySelectorAll("#agent-detail .panel-title")].map((t) => t.textContent)).toEqual(["Identity", "Tools", "Guardrail paths"]);
    expect([...document.querySelectorAll("#agent-detail dl.kv dt")].map((t) => t.textContent)).toEqual(["Station", "Model", "Fallbacks", "Autonomy", "Budget / run", "Max diff", "Eval suite"]);
    cleanup();
    mountAgent("ag-nope");
    expect(await screen.findByText("Nothing to show")).toBeTruthy();
    expect(document.body.textContent).toContain("That agent does not exist.");
    expect(document.getElementById("ag-back")!.textContent).toBe("Work orders");
  });

  it("keeps the tab in the URL (#agents/<id>?tab=) and restores it from a link", async () => {
    setup();
    window.location.hash = "#agents/ag-build?tab=versions";
    mount(<AgentsView />);
    await byId("ag-vers");
    expect(document.getElementById("ag-tab-versions")!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await byId("ag-tab-skills"));
    await waitFor(() => expect(window.location.hash).toBe("#agents/ag-build?tab=skills"));
    await byId("ag-sk-open-sk-a");
  });

  it("labels every roster cell with its column so the phone layout can stack them", async () => {
    setup();
    mount(<AgentsView />);
    const row = await byId("ag-row-ag-build");
    const strip = (t: string | null) => (t ?? "").replace(/[↕↑↓ ]/g, "");
    const heads = [...document.querySelectorAll("#ag-roster thead th")].map((h) => strip(h.textContent));
    expect([...row.querySelectorAll("td")].map((c) => strip(c.getAttribute("data-label")))).toEqual(heads);
  });

  it("writes the model, autonomy and a tool at once with a toast, and shows no Edit buttons or Save bar", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    const model = (await byId("ag-model")) as HTMLSelectElement;
    expect(document.querySelectorAll("#agent-detail dl.kv .btn").length).toBe(0);
    expect(document.getElementById("ag-savebar")).toBeNull();
    expect(document.getElementById("ag-paths-edit")).toBeNull();
    await waitFor(() => expect(Array.from(model.options).some((o) => o.value === "claude-sonnet-5-5")).toBe(true));
    // every model of every vendor is offered, not only the enabled ones
    expect(Array.from(model.options).some((o) => o.value === "off-model")).toBe(true);
    fireEvent.change(model, { target: { value: "claude-sonnet-5-5" } });
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ body: { patch: { model: "claude-sonnet-5-5" } }, headers: { "if-match": "7" } });
    await screen.findByText("Model set to claude-sonnet-5-5");
    fireEvent.change(document.getElementById("ag-autonomy")!, { target: { value: "suggest" } });
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(2));
    await screen.findByText("Autonomy: suggest");
    fireEvent.click(await byId("ag-tool-merge"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(3));
    expect((writes(calls, "PATCH")[2]!.body as { patch: { tools: Record<string, boolean> } }).patch.tools.merge).toBe(true);
    await screen.findByText("merge enabled");
  });

  it("has one panel on Instructions, plain Open rows on Skills and MCP, no Edit column per project, and only Version history on Versions", async () => {
    setup();
    mountAgent();
    await tab("instructions");
    expect([...document.querySelectorAll("#agent-detail .panel-title")].map((t) => t.textContent)).toEqual(["Instructions"]);
    expect(document.getElementById("ag-instr-save")!.textContent).toBe("Save as new version");
    expect(document.getElementById("ag-instr-revert")!.textContent).toBe("Revert");
    await tab("skills");
    expect(await byId("ag-sk-open-sk-a")).toBeTruthy();
    expect(document.getElementById("ag-sk-add")).toBeNull();
    expect(document.getElementById("ag-mcp-add")).toBeNull();
    expect(document.querySelector("[id^=ag-sk-up-], [id^=ag-sk-rm-], [id^=ag-mcp-rm-]")).toBeNull();
    fireEvent.click(document.getElementById("ag-sk-open-sk-a")!);
    expect(window.location.hash).toBe("#skills/sk-a");
    cleanup();
    mountAgent();
    await tab("overrides");
    await byId("ag-ov");
    expect(document.querySelector("[id^=ag-ov-edit-]")).toBeNull();
    expect([...document.querySelectorAll("#ag-ov thead th")].map((t) => t.textContent)).toEqual(["Project", "Override", "Eval"]);
    await tab("versions");
    expect([...document.querySelectorAll("#agent-detail .panel-title")].map((t) => t.textContent)).toEqual(["Version history"]);
    expect(document.getElementById("ag-newver")).toBeNull();
    expect(document.querySelector("[id^=ag-runsuite-]")).toBeNull();
  });

  it("blocks autonomy on a regulated project with POL-112, naming the project", async () => {
    setup();
    mountAgent();
    const own = (await byId("ag-autonomy")) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(own.options).find((o) => o.value === "auto")!.disabled).toBe(true));
    expect(Array.from(own.options).find((o) => o.value === "auto")!.textContent).toContain("blocked by POL-112");
  });

  it("a person without the right sees every control locked with the reason", async () => {
    setup({}, ["agent.edit"]);
    mountAgent();
    await waitFor(() => expect(document.querySelector(".lock-note")).not.toBeNull());
    expect(document.querySelector(".lock-note")!.textContent).toContain("Read-only for you: agent configuration");
    expect(((await byId("ag-model")) as HTMLSelectElement).disabled).toBe(true);
    expect(document.getElementById("ag-pause")!.getAttribute("aria-disabled")).toBe("true");
    // the tool switches are locked too
    expect(document.getElementById("ag-tool-readRepo")!.closest("[aria-disabled=true], .is-locked, label")).not.toBeNull();
  });

  it("pauses an agent through a save with its version", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    fireEvent.click(await byId("ag-pause"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ body: { patch: { status: "paused" }, note: "status" }, headers: { "if-match": "7" } });
  });

  it("Versions: only live or retired chips, Roll back on every non-live row (candidate included), a dash on the live row, no Promote", async () => {
    setup();
    mountAgent();
    await tab("versions");
    await byId("ag-rollback-250");
    expect(document.getElementById("ag-rollback-270rc1")).not.toBeNull();
    expect(document.getElementById("ag-rollback-280rc1")).not.toBeNull();
    expect(document.querySelector("[id^=ag-promote-]")).toBeNull();
    expect(document.getElementById("ag-rollback-261")).toBeNull();
    const chips = [...document.querySelectorAll("#ag-vers tbody .chip")].map((c) => c.textContent?.toLowerCase());
    expect(chips.every((c) => c === "live" || c === "retired")).toBe(true);
    expect(document.querySelector("#ag-vers")!.textContent).toContain("—");
    const cols = [...document.querySelectorAll("#ag-vers thead th")].map((t) => t.textContent);
    expect(cols).toEqual(["Version", "Date", "Change", "Suite", "State", ""]);
  });

  it("rolls back through a confirmation that names both versions", async () => {
    const calls = setup({ "POST /api/v1/agents/ag-build/rollback": () => ok() });
    mountAgent();
    await tab("versions");
    fireEvent.click(await byId("ag-rollback-250"));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("Roll back to v2.5.0?");
    expect(dlg.textContent).toContain("The previous version stops serving new runs.");
    fireEvent.click(await byId("ag-rollback-ok"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]).toMatchObject({ path: "/api/v1/agents/ag-build/rollback", body: { version: "2.5.0" }, headers: { "if-match": "7" } });
  });

  it("no longer carries Trust or History tabs or a trust strip (Trust is its own screen)", async () => {
    setup();
    mountAgent("ag-review");
    await byId("agent-detail");
    expect(document.getElementById("ag-tab-trust")).toBeNull();
    expect(document.getElementById("ag-tab-history")).toBeNull();
  });

  it("saves the instructions as a new version: needs 20 characters, saves the draft, then cuts a candidate", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok(), "POST /api/v1/agents/ag-build/versions": () => ok() });
    mountAgent();
    await tab("instructions");
    expect(document.querySelector("#agent-detail .panel-title")!.textContent).toBe("Instructions");
    const ta = (await byId("ag-instr")) as HTMLTextAreaElement;
    expect(ta.getAttribute("aria-label")).toBe("Instructions");
    expect(ta.rows).toBe(8);
    expect(ta.value).toBe("Implement the approved plan on a branch.");
    fireEvent.change(ta, { target: { value: "too short" } });
    fireEvent.click(await byId("ag-instr-save"));
    await screen.findByText("Instructions need at least 20 characters");
    expect(writes(calls, "PATCH")).toHaveLength(0);
    fireEvent.click(await byId("ag-instr-revert"));
    await waitFor(() => expect(ta.value).toBe("Implement the approved plan on a branch."));
    fireEvent.change(ta, { target: { value: "Implement the approved plan on a branch, tests first." } });
    fireEvent.click(await byId("ag-instr-save"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]!.body.patch).toEqual({ instructions: "Implement the approved plan on a branch, tests first." });
    expect(writes(calls, "POST")[0]!.body).toMatchObject({ label: "2.7.0-rc2", note: "Edited in web" });
  });

});

describe("Skills screen", () => {
  /** A skill's drawer: `#skills/<id>`. */
  const mountSkill = (id: string) => { window.location.hash = `#skills/${id}`; return mount(<SkillsView />); };

  it("lists the library as the Blueprint does: no tiles, name and description, when, used by, owner, Edit, count footer", async () => {
    setup();
    mount(<SkillsView />);
    const row = await byId("sk-row-sk-a");
    expect(row.textContent).toContain("Test design");
    expect(row.textContent).not.toContain("v1.2.0");
    expect(row.textContent).toContain("1 agents");
    expect(row.textContent).toContain("Asha Raman");
    expect(row.textContent).not.toContain("all projects");
    expect(document.getElementById("sk-stats")).toBeNull();
    expect(document.getElementById("sk-f-view")).toBeNull();
    expect((await byId("sk-search")).getAttribute("aria-label")).toBe("Search skills");
    expect([...document.querySelectorAll("#sk-lib thead th")].map((t) => t.textContent!.replace(/[↕↑↓ ]/g, ""))).toEqual(["Skill", "Whentouse", "Usedby", "Owner", ""]);
    expect(document.querySelector("#sk-lib .tfoot")!.textContent).toContain("1–3 of 3");
    expect(document.querySelector(".ph .eyebrow")!.textContent).toContain("All lines");
    fireEvent.change(await byId("sk-search"), { target: { value: "security" } });
    await waitFor(() => expect(document.getElementById("sk-row-sk-a")).toBeNull());
    expect(document.getElementById("sk-row-sk-b")).not.toBeNull();
    fireEvent.change(await byId("sk-search"), { target: { value: "zzz" } });
    await screen.findByText("Nothing matches these filters");
    fireEvent.click(document.getElementById("sk-clear-empty")!);
    await byId("sk-row-sk-a");
  });

  it("opens a skill in a right-hand drawer from a row (WHEN, OWNER, USED BY, body, Edit), closes back to #skills, and says so when the skill is gone", async () => {
    setup();
    mount(<SkillsView />);
    fireEvent.click(await byId("sk-row-sk-a"));
    expect(window.location.hash).toBe("#skills/sk-a");
    const drw = await waitFor(() => { const e = document.querySelector("aside.drw"); if (!e) throw new Error("no drawer"); return e; });
    expect([...drw.querySelectorAll("dt")].map((t) => t.textContent)).toEqual(["When", "Owner", "Used by"]);
    expect(drw.querySelector("pre.pre")!.textContent).toBe("Test design body");
    expect(drw.querySelector("dl.kv")!.textContent).toContain("Builder");
    expect(drw.textContent).toContain("SKILL");
    expect(drw.querySelector("footer")!.textContent).toBe("Edit");
    fireEvent.click(drw.querySelector(".drawer-close")!);
    await waitFor(() => expect(window.location.hash).toBe("#skills"));
    await waitFor(() => expect(document.querySelector("aside.drw")).toBeNull());
    cleanup();
    mountSkill("sk-nope");
    expect(await screen.findByText("Nothing to show")).toBeTruthy();
    expect(document.body.textContent).toContain("That skill does not exist.");
  });

  it("Edit in the drawer closes it and opens the Edit skill dialog; saving sends only the changed fields with the skill's version", async () => {
    const calls = setup({ "PATCH /api/v1/skills/sk-a": () => ok() });
    mountSkill("sk-a");
    await waitFor(() => expect(document.querySelector("aside.drw")).not.toBeNull());
    fireEvent.click(await byId("sk-drawer-edit"));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("Edit skill");
    expect([...dlg.querySelectorAll("label")].map((l) => l.textContent!.replace(/ \*$| \(required\)$/, ""))).toEqual(expect.arrayContaining(["Name", "What it does", "When to use", "Instructions"]));
    fireEvent.change(await byId("sk-body"), { target: { value: "short" } });
    fireEvent.click(await byId("sk-save"));
    await screen.findByText("Instructions needs at least 20 characters.");
    fireEvent.change(await byId("sk-name"), { target: { value: "" } });
    fireEvent.click(await byId("sk-save"));
    await screen.findByText("Name is required.");
    expect(writes(calls, "PATCH")).toHaveLength(0);
    fireEvent.change(await byId("sk-name"), { target: { value: "Test design" } });
    fireEvent.change(await byId("sk-body"), { target: { value: "A better body that is long enough." } });
    fireEvent.click(await byId("sk-save"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ path: "/api/v1/skills/sk-a", body: { patch: { body: "A better body that is long enough." } }, headers: { "if-match": "4" } });
  });

  it("locks Edit and New for someone without the right", async () => {
    setup({}, ["skill.edit", "agent.edit"]);
    mount(<SkillsView />);
    await waitFor(() => expect(document.getElementById("sk-new")!.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("sk-edit-sk-a")!.getAttribute("data-reason")).toMatch(/No role holds skill.edit/);
  });

  it("creates a skill with an Idempotency-Key from the New skill dialog, with the four validation messages", async () => {
    const calls = setup({ "POST /api/v1/skills": () => ok({ msg: "Skill API review created.", skill: { ...SKILLS[0], id: "sk-new-1a2b", name: "API review" } }) });
    mount(<SkillsView />);
    fireEvent.click(await byId("sk-new"));
    fireEvent.click(await byId("sk-save"));
    await screen.findByText("Name is required.");
    expect(document.body.textContent).toContain("What it does is required.");
    expect(document.body.textContent).toContain("When to use is required.");
    expect(document.body.textContent).toContain("Instructions is required.");
    fireEvent.change(await byId("sk-name"), { target: { value: "API review" } });
    fireEvent.change(await byId("sk-desc"), { target: { value: "Diffs the contract." } });
    fireEvent.change(await byId("sk-when"), { target: { value: "At Design." } });
    fireEvent.change(await byId("sk-body"), { target: { value: "Diff the spec against the code." } });
    fireEvent.click(await byId("sk-save"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(writes(calls, "POST")[0]!.body).toMatchObject({ name: "API review", desc: "Diffs the contract.", when: "At Design.", body: "Diff the spec against the code." });
  });
});

describe("Agents screen: a read the person may not make", () => {
  it("says Not visible to you, not an empty list, when the primary read is refused", async () => {
    setup({ "GET /api/v1/agents": () => ({ status: 403, body: { ok: false, msg: "Your roles do not include agent.view." } }) });
    mount(<AgentsView />);
    await waitFor(() => expect(document.getElementById("agents-hidden")?.textContent).toContain("Not visible to you"));
    expect(document.getElementById("agents-hidden")?.textContent).toContain("agent.view");
  });
});

describe("Skills screen: a read the person may not make", () => {
  it("says Not visible to you when the skills read is refused", async () => {
    setup({ "GET /api/v1/skills": () => ({ status: 403, body: { ok: false, msg: "Your roles do not include skill.view." } }) });
    mount(<SkillsView />);
    await waitFor(() => expect(document.getElementById("skills-hidden")?.textContent).toContain("Not visible to you"));
  });
});

describe("Skills drawer", () => {
  it("carries only WHEN, OWNER, USED BY, the body and Edit: no extra disclosure", async () => {
    setup();
    window.location.hash = "#skills/sk-a";
    mount(<SkillsView />);
    await waitFor(() => expect(document.querySelector(".drawer, [role=dialog]")).not.toBeNull());
    await screen.findByText("Test design body");
    expect(document.querySelector("details.sk-more")).toBeNull();
    expect(document.body.textContent).not.toContain("Agents, projects and versions");
  });
});

