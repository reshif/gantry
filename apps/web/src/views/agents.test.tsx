import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient, invalidateSlices } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import { clearDrafts } from "../lib/useDraft";
import AgentsView from "./agents";
import SkillsView, { skillsUi } from "./skills";
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
/** The page has seven tabs (the prototype's); the former Settings, Per-project, Versions, Trust and History tabs live inside them. */
const PARENT: Record<string, string> = { settings: "guardrails", overrides: "guardrails", versions: "instructions", trust: "guardrails", history: "guardrails" };
const tab = async (id: string) => fireEvent.click(await byId(`ag-tab-${PARENT[id] ?? id}`));

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  clearDrafts();
  Object.assign(skillsUi, { sel: null, tab: "def", note: "", q: "", filter: "all" });
  Object.assign(agentsUi, { sel: null, tab: "config", ctxProject: null, ctxRepo: null, newVer: "", newNote: "" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agents screen", () => {
  it("lists the roster in the prototype's columns (agent, station, model, autonomy, version, eval, runs, status) and its four tiles", async () => {
    setup();
    mount(<AgentsView />);
    const row = await byId("ag-row-ag-build");
    const heads = [...document.querySelectorAll("#ag-roster thead th")].map((h) => h.textContent!.replace(/[\u2191\u2193\u2195]/g, "").trim());
    expect(heads).toEqual(["Agent", "Station", "Model", "Autonomy", "Version", "Eval", "Runs 30d", "Status"]);
    expect(row.textContent).toContain("Builder");
    expect(row.textContent).toContain("Build");
    expect(row.textContent).toContain("opus-5-5");
    expect(row.textContent).toContain("L2");
    expect(row.textContent).toContain("2.6.1");
    expect(row.textContent).toContain("0.80");
    expect(row.textContent).toContain("Busy");
    expect((await byId("ag-row-ag-review")).textContent).toContain("Paused");
    const head = document.getElementById("ag-stats")!.textContent!;
    expect(head).toContain("Agents2");
    expect(head).toContain("Avg eval score0.88");
    expect(head).toContain("Runs, 30 days");
    expect(head).toContain("Avg rework");
    expect(document.querySelector(".ph .sub")!.textContent).toBe("One agent per station. Each has instructions, tools, a model, a budget and an autonomy level people granted.");
    expect(document.getElementById("agent-create")!.textContent).toContain("New agent");
  });

  it("filters the roster by station, autonomy and search in the URL, clears them, and opens an agent from a row", async () => {
    setup();
    mount(<AgentsView />);
    await byId("ag-row-ag-build");
    fireEvent.change(document.getElementById("ag-f-station")!, { target: { value: "review" } });
    await waitFor(() => expect(document.getElementById("ag-row-ag-build")).toBeNull());
    expect(document.getElementById("ag-row-ag-review")).not.toBeNull();
    expect(window.location.search).toContain("station=review");
    fireEvent.click(await byId("ag-clear"));
    await waitFor(() => expect(document.getElementById("ag-row-ag-build")).not.toBeNull());
    expect(window.location.search).toBe("");
    fireEvent.change(document.getElementById("ag-f-lv")!, { target: { value: "0" } });
    await waitFor(() => expect(document.getElementById("ag-row-ag-build")).toBeNull());
    expect(window.location.search).toContain("lv=0");
    fireEvent.click(await byId("ag-empty-clear"));
    fireEvent.change(document.getElementById("ag-search")!, { target: { value: "build" } });
    await waitFor(() => expect(document.getElementById("ag-row-ag-review")).toBeNull());
    fireEvent.click(await byId("ag-row-ag-build"));
    expect(window.location.hash).toBe("#agents/ag-build");
  });

  it("shows one agent on its own page with its header line, and says so when the agent is gone", async () => {
    setup();
    mountAgent();
    await byId("agent-detail");
    expect(document.querySelector(".ph .eyebrow")!.textContent).toBe("Workforce \u00b7 Agent");
    expect(document.querySelector(".ph .sub")!.textContent).toContain("Build station \u00b7 claude-opus-5-5");
    expect([...document.querySelectorAll(".tabs [role=tab], .tabs button")].slice(0, 7).map((t) => t.textContent!.replace(/\d+$/, ""))).toEqual(["Overview", "Instructions", "Tools", "Model and budget", "Skills", "Guardrails", "Evals"]);
    expect(document.getElementById("ag-talk")).toBeTruthy();
    expect(document.getElementById("ag-back-link")).toBeTruthy();
    expect(document.getElementById("ag-row-ag-build")).toBeNull();
    cleanup();
    mountAgent("ag-nope");
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(document.body.textContent).toContain("There is no \u201cagent\u201d page");
  });

  it("sends the header buttons and the Overview card to the prototype's destinations, with the tab in the URL", async () => {
    setup();
    mountAgent();
    fireEvent.click(await byId("ag-open-guardrails"));
    await waitFor(() => expect(window.location.search).toContain("tab=guardrails"));
    expect(document.getElementById("ag-maxdiff")).toBeTruthy();
    fireEvent.click(await byId("ag-talk"));
    expect(window.location.hash).toMatch(/^#(\/p\/payments\/)?conversations$/);
    window.location.hash = "#agents/ag-build";
    fireEvent.click(await byId("ag-back-link"));
    expect(window.location.hash).toBe("#agents");
  });

  it("labels every roster cell with its column so the phone layout can stack them", async () => {
    setup();
    mount(<AgentsView />);
    const row = await byId("ag-row-ag-build");
    const heads = [...document.querySelectorAll("#ag-roster thead th")].map((h) => h.textContent!.replace(/[\u2191\u2193\u2195]/g, "").trim());
    expect([...row.querySelectorAll("td")].map((c) => c.getAttribute("data-label"))).toEqual(heads);
  });

  it("edits the configuration in a draft and saves one audited PATCH with the agent's version and only the changed keys", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("model");
    const budget = (await byId("ag-budget")) as HTMLInputElement;
    expect(document.getElementById("ag-savebar")).toBeNull();
    fireEvent.change(budget, { target: { value: "15" } });
    await tab("guardrails");
    fireEvent.change(await byId("ag-maxdiff"), { target: { value: "600" } });
    await tab("tools");
    fireEvent.click(await byId("ag-tool-postSlack"));
    await waitFor(() => expect(document.getElementById("ag-savebar")!.className).toContain("is-dirty"));
    fireEvent.click(document.getElementById("ag-save")!);
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    const c = writes(calls, "PATCH")[0]!;
    expect(c.path).toBe("/api/v1/agents/ag-build");
    expect(c.headers["if-match"]).toBe("7");
    expect(Object.keys(c.body.patch).sort()).toEqual(["budget", "guardrails", "tools"]);
    expect(c.body.patch.budget).toBe(15);
    expect(c.body.patch.guardrails).toEqual({ paths: ["infra/prod/**"], maxDiff: 600 });
    expect(c.body.note).toBe("tools, budget, guardrails");
  });

  it("does not revert a colleague's change to a key this person did not touch, and sends the new revision", async () => {
    let live = { ...BUILD };
    const calls = setup({ "GET /api/v1/agents": () => ({ body: [live, REVIEW] }), "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("guardrails");
    fireEvent.change(await byId("ag-maxdiff"), { target: { value: "600" } });
    live = { ...BUILD, rev: 8, budget: 20 };
    invalidateSlices(["agents"]);
    await tab("model");
    await waitFor(() => expect(((document.getElementById("ag-budget")) as HTMLInputElement).value).toBe("20"));
    expect(document.getElementById("ag-conflict")).toBeNull();
    fireEvent.click(await byId("ag-save"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    const c = writes(calls, "PATCH")[0]!;
    expect(Object.keys(c.body.patch)).toEqual(["guardrails"]);
    expect(c.headers["if-match"]).toBe("8");
  });

  it("shows a conflict instead of saving when the same key changed on both sides", async () => {
    let live = { ...BUILD };
    const calls = setup({ "GET /api/v1/agents": () => ({ body: [live, REVIEW] }), "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("model");
    fireEvent.change(await byId("ag-budget"), { target: { value: "15" } });
    live = { ...BUILD, rev: 8, budget: 20 };
    invalidateSlices(["agents"]);
    expect((await byId("ag-conflict")).getAttribute("role")).toBe("alert");
    fireEvent.click(await byId("ag-save"));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes(calls, "PATCH")).toHaveLength(0);
    fireEvent.click(await byId("ag-conflict-mine"));
    await waitFor(() => expect(document.getElementById("ag-conflict")).toBeNull());
    fireEvent.click(await byId("ag-save"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]!.body.patch).toEqual({ budget: 15 });
    expect(writes(calls, "PATCH")[0]!.headers["if-match"]).toBe("8");
  });

  it("keeps the draft across tabs and discards it on request", async () => {
    setup();
    mountAgent();
    await tab("model");
    fireEvent.change(await byId("ag-budget"), { target: { value: "33" } });
    await tab("overrides");
    await tab("model");
    expect(((await byId("ag-budget")) as HTMLInputElement).value).toBe("33");
    fireEvent.click(await byId("ag-discard"));
    await waitFor(() => expect(((document.getElementById("ag-budget")) as HTMLInputElement).value).toBe("12"));
  });

  it("blocks autonomy on a regulated project with POL-112, naming the project", async () => {
    setup();
    mountAgent();
    await tab("settings");
    const auto = (await byId("ag-aut-auto")) as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    expect(auto.closest("label")!.getAttribute("data-reason")).toMatch(/POL-112: no autonomous agents from Plan onward on regulated projects \(Risk and Compliance\)/);
    expect(auto.closest("label")!.textContent).toContain("Blocked by POL-112");
    await tab("overrides");
    const sel = (await byId("ag-ov-aut-risk")) as HTMLSelectElement;
    const opt = Array.from(sel.options).find((o) => o.value === "auto")!;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toContain("blocked by POL-112");
  });

  it("a person without the right sees every control locked with the reason, and the create button too", async () => {
    setup({}, ["agent.edit"]);
    mountAgent();
    await tab("settings");
    await waitFor(() => expect(document.querySelector(".lock-note")).not.toBeNull());
    expect(document.querySelector(".lock-note")!.textContent).toContain("Read-only for you: agent configuration");
    expect(((await byId("ag-name")) as HTMLInputElement).disabled).toBe(true);
    await tab("guardrails");
    expect((await byId("ag-pause")).getAttribute("aria-disabled")).toBe("true");
    cleanup();
    window.location.hash = "#agents";
    mount(<AgentsView />);
    await waitFor(() => expect(document.getElementById("agent-create")!.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("agent-create")!.getAttribute("data-reason")).toMatch(/Needs Factory Admin/);
  });

  it("pauses an agent through a save with its version", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("guardrails");
    fireEvent.click(await byId("ag-pause"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ body: { patch: { status: "paused" }, note: "paused" }, headers: { "if-match": "7" } });
  });

  it("reorders, detaches and attaches skills in the draft, then saves the new order", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("skills");
    expect(document.querySelectorAll(".ag-skill-chain li")).toHaveLength(2);
    expect((await byId("ag-sk-up-sk-a")).getAttribute("data-reason")).toBe("Already first.");
    fireEvent.click(await byId("ag-sk-up-sk-b"));
    await waitFor(() => expect(document.querySelector(".ag-skill-chain li")!.textContent).toContain("Security review"));
    fireEvent.click(await byId("ag-sk-sk-c"));
    await waitFor(() => expect(document.querySelectorAll(".ag-skill-chain li")).toHaveLength(3));
    fireEvent.click(await byId("ag-sk-sk-a"));
    fireEvent.click(await byId("ag-save"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]!.body.patch).toEqual({ skills: ["sk-b", "sk-c"] });
    // the MCP table: allowed toggle reflects the agent, scope is shown
    expect((document.getElementById("ag-mcp-mcp-docs") as HTMLInputElement).checked).toBe(true);
    expect(document.body.textContent).toContain("Scoped in MCP");
  });

  it("previews the live version: the real layer order, full skill bodies and the runner's own parts", async () => {
    const calls = setup();
    mountAgent();
    await tab("instructions");
    const pre = await byId("ag-effective");
    await waitFor(() => expect(pre.textContent).toContain("Base rules."));
    const titles = [...pre.querySelectorAll("h4")].map((h) => h.firstChild?.textContent ?? "");
    expect(titles).toEqual(["Factory base", "Project overlay", "Agent", "Repo guidelines (Gantry)", "Skill: Test design v1.2.0", "Station tools", "Result format", "First message"]);
    expect(pre.textContent).toContain("Test design body, in full.");
    expect(document.getElementById("ag-eff-station-tools")!.textContent).toContain("added by the runner");
    expect(document.getElementById("ag-eff-handoff")!.textContent).toContain("Station: <the station the agent works>");
    expect(document.getElementById("ag-eff-count")!.textContent).toMatch(/^\d+ words, about \d+ tokens$/);
    expect(document.getElementById("ag-repo-commit")!.textContent).toBe(`recorded at ${"a".repeat(12)}`);
    expect(document.getElementById("ag-eff-note")!.textContent).toContain("2.6.1");
    // The default asks for the floor version (no version parameter); the Draft toggle asks for the working copy.
    expect(calls.some((c) => c.path === "/api/v1/agents/ag-build/effective" && c.query.get("version") === null)).toBe(true);
    expect(calls.some((c) => c.path === "/api/v1/agents/ag-build/effective" && c.query.get("version") === "draft")).toBe(false);
    fireEvent.click(document.getElementById("ag-eff-version-draft")!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/agents/ag-build/effective" && c.query.get("version") === "draft")).toBe(true));
    await waitFor(() => expect(document.getElementById("ag-eff-note")!.textContent).toContain("not live yet"));
  });

  it("asks the server for the composition of the chosen project and repo", async () => {
    const calls = setup();
    mountAgent();
    await tab("instructions");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/agents/ag-build/effective" && c.query.get("project") === "payments" && c.query.get("repo") === "payments-api")).toBe(true));
    fireEvent.change(await byId("ag-ctx-project"), { target: { value: "risk" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/agents/ag-build/effective" && c.query.get("project") === "risk" && !c.query.get("repo"))).toBe(true));
  });

  it("edits the factory base with the base version as If-Match and refuses an empty text inline", async () => {
    const calls = setup({ "PUT /api/v1/instructions/base": () => ok({ version: 5 }) });
    mountAgent();
    await tab("instructions");
    fireEvent.click(await byId("ag-edit-base"));
    const ta = (await byId("ag-txt-edit")) as HTMLTextAreaElement;
    expect(ta.value).toBe("Base rules.");
    fireEvent.change(ta, { target: { value: "   " } });
    fireEvent.click(await byId("ag-txt-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")!.textContent).toBe("Base instructions cannot be empty."));
    expect(writes(calls, "PUT")).toHaveLength(0);
    fireEvent.change(ta, { target: { value: "New base rules that are long enough." } });
    fireEvent.click(await byId("ag-txt-ok"));
    await waitFor(() => expect(writes(calls, "PUT")).toHaveLength(1));
    expect(writes(calls, "PUT")[0]).toMatchObject({ path: "/api/v1/instructions/base", body: { text: "New base rules that are long enough." }, headers: { "if-match": "4" } });
  });

  it("shows a refusal from the server inside the dialog (stale base)", async () => {
    setup({ "PUT /api/v1/instructions/base": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mountAgent();
    await tab("instructions");
    fireEvent.click(await byId("ag-edit-base"));
    fireEvent.change(await byId("ag-txt-edit"), { target: { value: "New base rules that are long enough." } });
    fireEvent.click(await byId("ag-txt-ok"));
    await waitFor(() => expect(document.querySelector(".form-err")!.textContent).toMatch(/changed since you loaded/));
  });

  it("saves the project overlay and the repo guidelines through their own endpoints", async () => {
    const calls = setup({ "PATCH /api/v1/projects/payments/config": () => ok(), "PATCH /api/v1/repos/payments-api/config": () => ok() });
    mountAgent();
    await tab("instructions");
    fireEvent.click(await byId("ag-edit-overlay"));
    fireEvent.change(await byId("ag-txt-edit"), { target: { value: "Overlay v2" } });
    fireEvent.click(await byId("ag-txt-ok"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ path: "/api/v1/projects/payments/config", body: { path: "overlay", value: "Overlay v2" }, headers: { "if-match": "3" } });
    await waitFor(() => expect(document.getElementById("ag-txt-edit")).toBeNull());
    fireEvent.click(await byId("ag-edit-guidelines"));
    fireEvent.change(await byId("ag-txt-edit"), { target: { value: "Use npm." } });
    fireEvent.click(await byId("ag-txt-ok"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(2));
    expect(writes(calls, "PATCH")[1]).toMatchObject({ path: "/api/v1/repos/payments-api/config", body: { guidelines: "Use npm." }, headers: { "if-match": "5" } });
  });

  it("creates a candidate version from the saved configuration (only when nothing is unsaved), with a suggested label", async () => {
    const calls = setup({ "POST /api/v1/agents/ag-build/versions": () => ok() });
    mountAgent();
    await tab("versions");
    const label = (await byId("ag-newver")) as HTMLInputElement;
    expect(label.value).toBe("2.7.0-rc2");
    fireEvent.change(await byId("ag-newnote"), { target: { value: "Sonnet trial" } });
    fireEvent.click(await byId("ag-newver-go"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]).toMatchObject({ path: "/api/v1/agents/ag-build/versions", body: { label: "2.7.0-rc2", note: "Sonnet trial" }, headers: { "if-match": "7" } });
    // with unsaved edits the button says why it is locked
    await tab("model");
    fireEvent.change(await byId("ag-budget"), { target: { value: "40" } });
    await tab("versions");
    expect((await byId("ag-newver-go")).getAttribute("data-reason")).toMatch(/Save or discard your changes first/);
  });

  it("locks promotion with the eval gate's reason, and promotes an eligible candidate", async () => {
    const calls = setup({ "POST /api/v1/agents/ag-build/versions/2.8.0-rc1/promote": () => ok() });
    mountAgent();
    await tab("versions");
    const blocked = await byId("ag-promote-270rc1");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.getAttribute("data-reason")).toBe("Needs a passing run of SUITE-BUILD. No run of SUITE-BUILD yet.");
    fireEvent.click(blocked);
    expect(writes(calls, "POST")).toHaveLength(0);
    const eligible = await byId("ag-promote-280rc1");
    expect(eligible.getAttribute("aria-disabled")).toBeNull();
    expect(eligible.className).toContain("btn-primary");
    fireEvent.click(eligible);
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.headers["if-match"]).toBe("7");
    // the live version and a retired one: no promote on live, rollback only on a retired one
    expect(document.getElementById("ag-promote-261")).toBeNull();
    expect(document.getElementById("ag-rollback-250")).not.toBeNull();
    expect(document.getElementById("ag-rollback-261")).toBeNull();
  });

  it("shows a promotion refusal from the server as an error toast", async () => {
    setup({ "POST /api/v1/agents/ag-build/versions/2.8.0-rc1/promote": () => ({ status: 403, body: { ok: false, msg: "Blocked: Blocked: 70% vs 85% on SUITE-BUILD.", needs: "Needs SUITE-BUILD at 85% or better" } }) });
    mountAgent();
    await tab("versions");
    fireEvent.click(await byId("ag-promote-280rc1"));
    await screen.findByText(/Blocked: Blocked: 70% vs 85%/);
  });

  it("rolls back through a confirmation that names both versions", async () => {
    const calls = setup({ "POST /api/v1/agents/ag-build/rollback": () => ok() });
    mountAgent();
    await tab("versions");
    fireEvent.click(await byId("ag-rollback-250"));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("Roll back Builder to 2.5.0");
    expect(dlg.textContent).toContain("Restores the saved configuration: model, skills.");
    fireEvent.click(await byId("ag-rollback-ok"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]).toMatchObject({ path: "/api/v1/agents/ag-build/rollback", body: { version: "2.5.0" }, headers: { "if-match": "7" } });
  });

  it("shows the agent's audit history", async () => {
    setup();
    mountAgent();
    await tab("history");
    await waitFor(() => expect(document.querySelector(".ag-hist .history li")).not.toBeNull());
    expect(document.querySelector(".ag-hist .history li")!.textContent).toContain("agent.edit");
  });

  it("explains that an agent no human gate judges has no trust level", async () => {
    setup();
    mountAgent();
    await tab("trust");
    expect((await screen.findByText("Not judged at a gate")).closest("section")!.textContent).toContain("Builder does not staff the station before a human gate");
  });

  it("shows trust levels by class for an agent a gate judges, with proposals and demotions, linking to Trust", async () => {
    const cell = { id: "ag-review|feature|payments", agent: "ag-review", cls: "feature", project: "payments", repo: null, level: 3, since: NOW, cleanRuns: 4, history: [{ at: NOW - 86_400_000, from: 3, to: 2, by: "system", kind: "demote", reason: "Reverted release" }] };
    setup({ "GET /api/v1/trust/cells": () => ok({ sampleRate: 5, criteria: {}, ceilings: [{ id: "C1", text: "x", max: 2, enabled: true, when: { regulated: false } }], cells: [cell], proposals: [{ id: "TP-1", cell: cell.id, from: 3, to: 4, at: NOW, status: "pending" }], nextProposal: 2, seededAt: 0 }) });
    mountAgent("ag-review");
    await tab("trust");
    const btn = await byId("ag-trust-payments-feature");
    expect(btn.textContent).toContain("L3");
    expect(btn.textContent).toContain("→L2");
    expect(btn.textContent).toContain("▲L4");
    expect(document.body.textContent).toContain("is judged at G5");
    expect(document.getElementById("ag-trust-dem-0")!.textContent).toContain("Reviewer · feature · Payments Platform");
    expect(document.body.textContent).toContain("L3 ▼ L2: Reverted release");
    fireEvent.click(btn);
    expect(window.location.hash).toBe("#trust");
  });

  it("creates an agent from the New agent dialog (name, station, model) at the lowest autonomy, once, and opens it", async () => {
    const calls = setup({ "POST /api/v1/agents": () => ok({ agent: { ...BUILD, id: "ag-docs-1a2b", name: "Docs Writer" } }) });
    mount(<AgentsView />);
    fireEvent.click(await byId("agent-create"));
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain("New agent");
    expect(dlg.textContent).toContain("Agents start at autonomy L0: every output goes to a person.");
    expect(dlg.textContent).toContain("Name (required)");
    fireEvent.change(await byId("na-name"), { target: { value: "Docs Writer" } });
    fireEvent.change(await byId("na-station"), { target: { value: "close" } });
    fireEvent.click(await byId("na-ok"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    const c = writes(calls, "POST")[0]!;
    expect(c.path).toBe("/api/v1/agents");
    expect(c.headers["idempotency-key"]).toBeTruthy();
    expect(c.body).toMatchObject({ name: "Docs Writer", station: "close", autonomy: "suggest", projects: "all", stations: ["close"] });
    await waitFor(() => expect(window.location.hash).toBe("#agents/ag-docs-1a2b"));
  });

  it("refuses the New agent dialog without a name or with a short one, and sends nothing", async () => {
    const calls = setup();
    mount(<AgentsView />);
    fireEvent.click(await byId("agent-create"));
    fireEvent.click(await byId("na-ok"));
    expect((await screen.findByRole("dialog")).textContent).toContain("Name is required.");
    fireEvent.change(await byId("na-name"), { target: { value: "ab" } });
    fireEvent.click(await byId("na-ok"));
    await waitFor(() => expect(document.body.textContent).toContain("Name needs at least 3 characters."));
    expect(writes(calls, "POST")).toHaveLength(0);
  });
});

describe("Skills screen", () => {
  /** A skill's own page: `#skills/<id>`. */
  const mountSkill = (id: string) => { window.location.hash = `#skills/${id}`; return mount(<SkillsView />); };
  const sTab = async (id: string) => fireEvent.click(await byId(`sk-tab-${id}`));

  it("lists the library in the prototype's columns, filters by station and search, and opens the drawer from the name", async () => {
    const calls = setup({ "PUT /api/v1/skills/sk-a/projects": () => ok() });
    mount(<SkillsView />);
    const row = await byId("sk-row-sk-a");
    const heads = [...document.querySelectorAll("#sk-lib thead th")].map((h) => h.textContent!.replace(/[\u2191\u2193\u2195]/g, "").trim());
    expect(heads).toEqual(["Skill", "Station", "Used by", "Version", "Uses", "Enabled"]);
    expect(row.textContent).toContain("Test design");
    expect(row.textContent).toContain("Build");
    expect(row.textContent).toContain("Builder");
    expect(row.textContent).toContain("1.2.0");
    expect(document.querySelector(".ph .sub")!.textContent).toBe("Reusable know-how that agents load. Versioned, reviewed, and measured by evals.");
    fireEvent.change(await byId("sk-f-station"), { target: { value: "review" } });
    await waitFor(() => expect(document.getElementById("sk-row-sk-a")).toBeNull());
    expect(window.location.search).toContain("station=review");
    fireEvent.click(await byId("sk-clear"));
    fireEvent.change(await byId("sk-search"), { target: { value: "security" } });
    await waitFor(() => expect(document.getElementById("sk-row-sk-a")).toBeNull());
    expect(document.getElementById("sk-row-sk-b")).not.toBeNull();
    fireEvent.click(await byId("sk-clear"));
    fireEvent.click((await byId("sk-row-sk-a")).querySelector("a.sk-name")!);
    const drawer = await byId("sk-drawer");
    expect(drawer.textContent).toContain("Skill \u00b7 v1.2.0");
    expect(drawer.textContent).toContain("Skill file");
    fireEvent.click(await byId("sk-drawer-edit"));
    await waitFor(() => expect(document.body.textContent).toContain("Opened a draft of Test design"));
    expect(window.location.hash).toBe("");
    expect(document.getElementById("sk-drawer")).not.toBeNull();
    fireEvent.click(await byId("sk-drawer-page"));
    expect(window.location.hash).toBe("#skills/sk-a");
    cleanup();
    window.location.hash = "#skills";
    mount(<SkillsView />);
    fireEvent.click(await byId("sk-en-sk-a"));
    await waitFor(() => expect(writes(calls, "PUT")).toHaveLength(1));
    expect(writes(calls, "PUT")[0]!.body).toEqual({ projects: [] });
  });

  it("shows the prototype 404 page for a skill that is gone", async () => {
    setup();
    mountSkill("sk-nope");
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(document.body.textContent).toContain("There is no \u201cskill\u201d page");
  });

  it("saves an edit as a new version with the change note, the changed fields only and the skill's version", async () => {
    const calls = setup({ "PATCH /api/v1/skills/sk-a": () => ok() });
    mountSkill("sk-a");
    expect((await byId("sk-save")).textContent).toContain("Save as v1.3.0");
    fireEvent.click(await byId("sk-save"));
    expect(writes(calls, "PATCH")).toHaveLength(0);
    fireEvent.change(await byId("sk-body"), { target: { value: "Better body" } });
    fireEvent.change(await byId("sk-res"), { target: { value: "a.md\nb.md" } });
    fireEvent.change(await byId("sk-note"), { target: { value: "clearer" } });
    fireEvent.click(await byId("sk-save"));
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]).toMatchObject({ path: "/api/v1/skills/sk-a", body: { patch: { body: "Better body", resources: ["a.md", "b.md"] }, note: "clearer" }, headers: { "if-match": "4" } });
  });

  it("attaches and detaches the skill on agents through the agent endpoint", async () => {
    const calls = setup({ "PUT /api/v1/agents/ag-review/skills/sk-a": () => ok({ msg: "Attached Test design to Reviewer." }), "DELETE /api/v1/agents/ag-build/skills/sk-a": () => ok({ msg: "Detached Test design from Builder." }) });
    mountSkill("sk-a");
    await sTab("agents");
    expect((await byId("sk-att-ag-build") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(await byId("sk-att-ag-review"));
    await waitFor(() => expect(writes(calls, "PUT")).toHaveLength(1));
    fireEvent.click(await byId("sk-att-ag-build"));
    await waitFor(() => expect(writes(calls, "DELETE")).toHaveLength(1));
    await screen.findByText("Detached Test design from Builder.");
  });

  it("scopes the skill to projects: all, then per project", async () => {
    const calls = setup({ "PUT /api/v1/skills/sk-b/projects": () => ok() });
    mountSkill("sk-b");
    await sTab("projects");
    expect((await byId("sk-proj-payments") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("sk-proj-risk") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(document.getElementById("sk-proj-risk")!);
    await waitFor(() => expect(writes(calls, "PUT")).toHaveLength(1));
    expect(writes(calls, "PUT")[0]).toMatchObject({ path: "/api/v1/skills/sk-b/projects", body: { projects: ["payments", "risk"] } });
    fireEvent.click(await byId("sk-proj-all"));
    await waitFor(() => expect(writes(calls, "PUT")).toHaveLength(2));
    expect(writes(calls, "PUT")[1]!.body).toEqual({ projects: "all" });
  });

  it("locks the definition, scoping and attach controls for someone without the right", async () => {
    setup({}, ["skill.edit", "agent.edit"]);
    mountSkill("sk-a");
    await waitFor(() => expect(document.querySelector(".lock-note")).not.toBeNull());
    expect(((await byId("sk-name")) as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("sk-save")!.getAttribute("data-reason")).toMatch(/No role holds skill.edit/);
    cleanup();
    window.location.hash = "#skills";
    mount(<SkillsView />);
    await waitFor(() => expect(document.getElementById("sk-new")!.getAttribute("aria-disabled")).toBe("true"));
  });

  it("lists versions and the audit history", async () => {
    setup({ "GET /api/v1/learning/proposals": () => ({ body: [{ id: "LP-1", finding: "F-1", kind: "skill", title: "Tighten test design", owner: "p-asha", status: "proposed", at: NOW, expected: "", change: { skill: "sk-a" }, history: [] }] }) });
    mountSkill("sk-a");
    await sTab("versions");
    expect((await screen.findAllByText("v1.2.0")).length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".sk-vers li")).toHaveLength(2);
    expect(document.querySelector(".sk-vers li.is-current")!.textContent).toContain("Tightened");
    await screen.findByText("LP-1 Tighten test design");
  });

  it("creates a draft skill from the prototype dialog (name, station, what it teaches), attaches it, and stays on the list", async () => {
    const calls = setup({ "POST /api/v1/skills": () => ok({ msg: "Skill API review created.", skill: { ...SKILLS[0], id: "sk-new-1a2b", name: "API review" } }), "PUT /api/v1/agents/ag-review/skills/sk-new-1a2b": () => ok() });
    mount(<SkillsView />);
    fireEvent.click(await byId("sk-new"));
    fireEvent.click(await byId("sk-new-ok"));
    await waitFor(() => expect(document.body.textContent).toContain("Name is required."));
    fireEvent.change(await byId("sk-new-name"), { target: { value: "API review" } });
    fireEvent.change(await byId("sk-new-desc"), { target: { value: "short" } });
    fireEvent.click(await byId("sk-new-ok"));
    await waitFor(() => expect(document.body.textContent).toContain("at least 10 characters"));
    fireEvent.change(await byId("sk-new-desc"), { target: { value: "Diff the spec against the code." } });
    fireEvent.change(await byId("sk-new-station"), { target: { value: "review" } });
    expect(document.getElementById("sk-new-attach")).toBeNull();
    fireEvent.click(await byId("sk-new-ok"));
    await waitFor(() => expect(writes(calls, "POST")).toHaveLength(1));
    expect(writes(calls, "POST")[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(writes(calls, "POST")[0]!.body).toMatchObject({ name: "API review", desc: "Diff the spec against the code." });
    await waitFor(() => expect(document.body.textContent).toContain("Draft created"));
    expect(writes(calls, "PUT")).toHaveLength(0);
    expect(window.location.hash).toBe("");
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

describe("agent page layout (prototype)", () => {
  it("has exactly the seven prototype tabs and only All agents and Talk in the header", async () => {
    setup();
    mountAgent();
    await byId("ag-tab-overview");
    const ids = [...document.querySelectorAll("[id^=ag-tab-]")].map((e) => e.id.replace("ag-tab-", ""));
    expect(ids).toEqual(["overview", "instructions", "tools", "model", "skills", "guardrails", "evals"]);
    expect(document.getElementById("ag-pause")).toBeNull();
    expect(document.getElementById("ag-back-link")).toBeTruthy();
    expect(document.getElementById("ag-talk")).toBeTruthy();
  });
});

describe("work1 round 3 fixes", () => {
  it("New agent has Name, Station and Model only (no template field)", async () => {
    setup();
    mount(<AgentsView />);
    fireEvent.click(await byId("agent-create"));
    await byId("na-name");
    expect(document.getElementById("na-tpl")).toBeNull();
    expect(document.getElementById("na-station")).not.toBeNull();
    expect(document.getElementById("na-model")).not.toBeNull();
  });
  it("Runs are a 30-day figure and the Model tab holds only Model and Budget", async () => {
    setup();
    mountAgent();
    await tab("model");
    await byId("ag-budget");
    expect(document.getElementById("ag-model")).not.toBeNull();
    expect(document.getElementById("ag-aut-auto")).toBeNull();
    expect(document.getElementById("ag-fb-add")).toBeNull();
    await tab("guardrails");
    await byId("ag-fb-add");
  });
  it("sensitive tools are switched off and locked; toast reads Enabled/Disabled <tool>", async () => {
    setup();
    mountAgent();
    await tab("tools");
    const merge = (await byId("ag-tool-merge")) as HTMLInputElement;
    expect(merge.getAttribute("aria-disabled")).toBe("true");
    expect(merge.getAttribute("aria-label")).toBe("merge");
    fireEvent.click(await byId("ag-tool-postSlack"));
    await waitFor(() => expect(document.body.textContent).toContain("Disabled postSlack"));
    expect(document.body.textContent).not.toContain("Save the agent to keep it");
  });
});

describe("work1 residual round 2", () => {
  it("saves Model at once as one PATCH with only that key and toasts Saved model", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("model");
    const sel = (await byId("ag-model")) as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].some((o) => o.value === "claude-sonnet-5-5")).toBe(true));
    fireEvent.change(sel, { target: { value: "claude-sonnet-5-5" } });
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    const c = writes(calls, "PATCH")[0]!;
    expect(c.body.patch).toEqual({ model: "claude-sonnet-5-5" });
    expect(c.headers["if-match"]).toBe("7");
    await waitFor(() => expect(document.body.textContent).toContain("Saved model"));
  });
  it("saves Budget when the field is left, with only that key, and toasts Saved budget", async () => {
    const calls = setup({ "PATCH /api/v1/agents/ag-build": () => ok() });
    mountAgent();
    await tab("model");
    const b = (await byId("ag-budget")) as HTMLInputElement;
    fireEvent.change(b, { target: { value: "9" } });
    expect(writes(calls, "PATCH")).toHaveLength(0);
    fireEvent.blur(b);
    await waitFor(() => expect(writes(calls, "PATCH")).toHaveLength(1));
    expect(writes(calls, "PATCH")[0]!.body.patch).toEqual({ budget: 9 });
    await waitFor(() => expect(document.body.textContent).toContain("Saved budget"));
  });
  it("opens an agent with no text of its own as '# Name' over the factory base, without making a draft of it", async () => {
    setup({ "GET /api/v1/agents": () => ({ body: [{ ...BUILD, instructions: "" }, REVIEW] }) });
    mountAgent();
    await tab("instructions");
    const t = (await byId("ag-instr-main")) as HTMLTextAreaElement;
    await waitFor(() => expect(t.value).toBe("# Builder\n\nBase rules."));
    expect(document.getElementById("ag-savebar")).toBeNull();
  });
  it("names a saved candidate next to the live version in the counter", async () => {
    setup();
    mountAgent();
    await tab("instructions");
    await waitFor(() => expect(document.getElementById("ag-instr-count")!.textContent).toContain("live version 2.6.1 · 2.8.0-rc1 saved"));
  });
  it("honours the prototype's deep link with the tab in the hash", async () => {
    setup();
    window.location.hash = "#agents/ag-build?tab=tools";
    mount(<AgentsView />);
    await byId("ag-tool-postSlack");
  });
  it("opens the new agent's page from the list when the server's reply does not name it", async () => {
    let made = false;
    setup({
      "GET /api/v1/agents": () => ({ body: made ? [...AGENTS, { ...BUILD, id: "ag-docs-9", name: "Docs Writer" }] : AGENTS }),
      "POST /api/v1/agents": () => { made = true; return ok(); },
    });
    mount(<AgentsView />);
    fireEvent.click(await byId("agent-create"));
    fireEvent.change(await byId("na-name"), { target: { value: "Docs Writer" } });
    fireEvent.click(await byId("na-ok"));
    await waitFor(() => expect(window.location.hash).toBe("#agents/ag-docs-9"));
  });
  it("a click on a skill row outside the name does not open the drawer", async () => {
    setup();
    mount(<SkillsView />);
    const row = await byId("sk-row-sk-a");
    fireEvent.click(row.querySelectorAll("td")[3]!);
    expect(document.getElementById("sk-drawer")).toBeNull();
  });
});
