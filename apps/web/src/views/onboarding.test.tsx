import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG, devSeed, type Project, type Repo } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import OnboardingView from "./onboarding";
import { mockApi, mount, resetApp, type Call } from "./floor/testkit";

const SEED = devSeed(Date.now()).state;
const STOREFRONT = { ...(SEED.projects.find((p) => p.id === "storefront") as Project), version: 3 };
const REPOS = SEED.repos.filter((r) => r.project === "storefront").map((r) => ({ ...r, version: 5 })) as Array<Repo & { version: number }>;
const daniel = SEED.people.find((p) => p.id === "p-daniel")!;
const NOW = Date.now();

const find = (id: string) => REPOS.find((r) => r.id === id)!;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const live = (checks: Array<{ id: string; label: string; ok: boolean; unknown?: boolean; detail: string }>) => ({ at: NOW - 3600_000, ok: checks.every((c) => c.ok), trigger: "merge" as const, unknown: false, checks });

/** A repo at a stage, built from a seeded one so every field the screen reads exists. */
const repo = (id: string, patch: (r: Repo & { version: number }) => void): Repo & { version: number } => {
  const r = clone(find(id));
  patch(r);
  return r;
};
const GREEN = repo("mobile-app", (r) => {
  r.onboarding.stage = "pr_checks";
  r.onboarding.pr!.checks = "green";
  r.onboarding.pr!.headSha = "b".repeat(40);
  r.onboarding.pr!.url = "https://github.test/acme/mobile-app/pull/338";
});
const GUIDELINES = { version: 3, by: "p-daniel", at: NOW - 86_400_000, items: SEED.guidelines.items, may: SEED.guidelines.may, mayNot: SEED.guidelines.mayNot, history: SEED.guidelines.history };

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "storefront" });
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  cleanup();
  vi.unstubAllGlobals();
});

const ok = (msg: string, extra: object = {}) => ({ body: { ok: true, msg, ...extra } });
function api(repos: Array<Repo & { version: number }>, extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}, o: { denied?: string[] } = {}) {
  return mockApi(
    {
      "GET /api/v1/projects": () => ({ body: [STOREFRONT] }),
      "GET /api/v1/projects/storefront/repos": () => ({ body: repos }),
      "GET /api/v1/guidelines": () => ({ body: GUIDELINES }),
      "GET /api/v1/teams": () => ({ body: [{ id: "growth", name: "Growth" }, { id: "platform", name: "Platform" }] }),
      "GET /api/v1/integrations": () => ({ body: [] }),
      "GET /api/v1/integration-types": () => ({ body: [] }),
      "GET /api/v1/audit": () => ({ body: [] }),
      "GET /api/v1/projects/storefront/repos/available": () => ({ body: { available: [{ repo: "acme/new-service", lang: "Go" }, { repo: "acme/ledger", lang: "Java" }] } }),
      ...Object.fromEntries(repos.map((r) => [`GET /api/v1/repos/${r.id}/onboarding/session`, () => ({ body: sessionOf(r) })])),
      ...extra,
    },
    { me: { person: daniel, projects: [STOREFRONT] }, ...o },
  );
}
/** The least a session needs: no conversation yet, the agent off. */
const sessionOf = (r: Repo) => ({ repoId: r.id, repo: r.name, project: "storefront", messages: [], agent: { mode: "rule-based", reason: "No model is configured." }, budget: { spentUsd: 0, limitUsd: 1 }, costUsd: 0, can: { talk: false, merge: true, talkWhy: "" }, steps: [], next: { actor: "you", text: "review" }, stage: r.onboarding.stage, busy: null, prNeedsUpdate: false, waiting: null, prChecks: null });
const posts = (calls: Call[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
/** Opens a repo's details drawer the way a person does: its session page, the Settings tab, "Details and settings". */
const open = async (repoId: string) => {
  window.location.hash = `#/p/storefront/onboarding/${repoId}`;
  fireEvent.click(await byId("osx-tab-settings"));
  fireEvent.click(await byId("osx-details"));
  return byId("onb-act-rerun");
};
const locked = (id: string): string | null => { const e = document.getElementById(id)!; return e.getAttribute("aria-disabled") === "true" ? e.getAttribute("data-reason") : null; };

describe("Onboarding: pipeline", () => {
  it("says the repos are not visible on a 403", async () => {
    api([], { "GET /api/v1/projects/storefront/repos": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<OnboardingView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });

  it("is the Blueprint's page: drawing number and project key, four tiles, Pipeline and Guidelines tabs, no agent-profile button or Details links", async () => {
    api([find("web-storefront"), GREEN, find("search-indexer"), repo("notifications", (r) => { r.onboarding.stage = "connected"; r.onboarding.pr = null; r.onboarding.findings = []; })]);
    window.location.hash = "#/p/storefront/onboarding";
    mount(<OnboardingView />);
    expect(await screen.findByText("Onboarding")).toBeTruthy();
    expect(document.querySelector(".vhead .kicker")?.textContent).toBe("GNT-ONB-09·WEB");
    expect(Array.from(document.querySelectorAll(".stats .stat .micro")).map((d) => d.textContent)).toEqual(["Waiting", "In progress", "Ready", "Guidelines"]);
    expect(Array.from(document.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Pipeline", "Guidelines"]);
    await byId("onb-list");
    expect(Array.from(document.querySelectorAll("#onb-list thead th")).map((t) => t.textContent?.replace(/[↑↓↕]/, "").trim())).toEqual(["Repository", "Stage", "Status", "Gaps", ""]);
    expect(document.getElementById("onb-agent-profile")).toBeNull();
    expect(document.querySelector(".onb-callout, .footnote")).toBeNull();
    expect(document.getElementById("onb-detail-mobile-app")).toBeNull();
  });

  it("each repo shows five stage segments and a status chip; waiting repos (connected, or seen by the App) get Start, the others Open", async () => {
    api([GREEN, repo("notifications", (r) => { r.onboarding.stage = "connected"; r.onboarding.pr = null; r.onboarding.findings = []; })]);
    mount(<OnboardingView />);
    await byId("onb-open-mobile-app");
    const row = (name: string) => Array.from(document.querySelectorAll("#onb-list tbody tr")).find((tr) => tr.textContent?.includes(name))!;
    expect(row("acme/mobile-app").querySelectorAll('[role="img"] span')).toHaveLength(5);
    expect(row("acme/mobile-app").querySelector(".chip")?.textContent).toMatch(/Merge/); // green PR waiting for a merge is the Merge stage
    expect(row("acme/notifications").querySelector("#onb-start-notifications")?.textContent).toBe("Start");
    expect(row("acme/new-service").querySelector("button")?.textContent).toBe("Start"); // a repo the App sees, not connected yet
    expect(document.getElementById("onb-open-mobile-app")?.textContent).toBe("Open");
    // the Conversation action opens the session focused on the chat (URL state)
    expect(document.getElementById("onb-chat-notifications")).toBeNull();
    // not started: nothing to talk about yet
    fireEvent.click(document.getElementById("onb-chat-mobile-app")!);
    expect(window.location.hash).toMatch(/onboarding\/mobile-app\?focus=chat$/);
  });

  it("filters by stage and searches, with a live count and Clear", async () => {
    api([find("web-storefront"), GREEN, find("search-indexer")]);
    mount(<OnboardingView />);
    await byId("onb-open-mobile-app");
    const count = () => document.querySelector("#onb-list .fbar .count")?.textContent;
    expect(count()).toBe("4 repos");
    fireEvent.change(document.getElementById("onb-list-f-stage") as HTMLSelectElement, { target: { value: "0" } });
    await waitFor(() => expect(count()).toBe("2 repos of 4"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(count()).toBe("4 repos"));
    fireEvent.change(screen.getByLabelText("Search repo"), { target: { value: "zzz-nothing" } });
    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
  });

  it("a row opens the repo's session from its name; Start opens the Onboard dialog on that repo and connects it", async () => {
    const calls = api([GREEN], { "POST /api/v1/projects/storefront/repos": () => ok("Connected.", { repo: { id: "new-service" } }) });
    mount(<OnboardingView />);
    const link = (await waitFor(() => { const a = document.querySelector('#onb-list a.pri'); if (!a) throw new Error("no link"); return a; })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/p/storefront/onboarding/mobile-app");
    fireEvent.click(await byId("onb-start-acme/new-service"));
    expect(await screen.findByText("Onboard acme/new-service")).toBeTruthy();
    expect((document.getElementById("fd-repo") as HTMLSelectElement).value).toBe("acme/new-service");
    fireEvent.click(screen.getByRole("button", { name: "Start assessment" }));
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/projects/storefront/repos")).toHaveLength(1));
    expect(posts(calls, "POST", "/api/v1/projects/storefront/repos")[0]!.body).toMatchObject({ name: "acme/new-service" });
    await waitFor(() => expect(window.location.hash).toMatch(/onboarding\/new-service$/));
  });

  it("a project with no team connects a repo without inventing one (the server picks the project's team or none)", async () => {
    const saved = STOREFRONT.teams;
    STOREFRONT.teams = [];
    try {
      const calls = api([GREEN], { "POST /api/v1/projects/storefront/repos": () => ok("Connected.", { repo: { id: "new-service" } }) });
      mount(<OnboardingView />);
      fireEvent.click(await byId("onb-start-acme/new-service"));
      fireEvent.click(await screen.findByRole("button", { name: "Start assessment" }));
      await waitFor(() => expect(posts(calls, "POST", "/api/v1/projects/storefront/repos")).toHaveLength(1));
      expect(posts(calls, "POST", "/api/v1/projects/storefront/repos")[0]!.body).toMatchObject({ name: "acme/new-service", team: null });
    } finally {
      STOREFRONT.teams = saved;
    }
  });

  it("the Guidelines tab is in the URL, lists one switch per guideline and says what the agent may never do", async () => {
    const calls = api([GREEN], { "PUT /api/v1/guidelines": () => ok("Saved.") });
    mount(<OnboardingView />);
    fireEvent.click(await byId("onb-tab-guidelines"));
    expect(window.location.search).toBe("?tab=guidelines");
    const sw = await byId(`onb-gl-sw-${GUIDELINES.items[3]!.id}`);
    expect(document.querySelectorAll("[id^=onb-gl-sw-]")).toHaveLength(GUIDELINES.items.length);
    expect(document.querySelector(".callout")?.textContent).toContain("The agent may never");
    fireEvent.click(sw);
    await waitFor(() => expect(posts(calls, "PUT", "/api/v1/guidelines")).toHaveLength(1));
    window.history.replaceState(null, "", "/");
  });

  it("Onboard a repo is locked with the server's reason when the person cannot onboard", async () => {
    api([find("web-storefront")], {}, { denied: ["repo.onboard"] });
    mount(<OnboardingView />);
    await byId("onb-start-acme/new-service");
    await waitFor(() => expect(locked("onb-connect")).toMatch(/Needs Factory Admin|No role holds it/));
  });
});

describe("Onboarding: repo drawer", () => {
  it("lists findings with severity and what fixes them, and has no simulation control", async () => {
    api([find("search-indexer")]);
    mount(<OnboardingView />);
    await open("search-indexer");
    expect(document.getElementById("onb-act-checks")).toBeNull(); // "Simulate checks pass" is not a product control
    fireEvent.click(await byId("onb-dtab-findings"));
    const items = Array.from(document.querySelectorAll(".onb-findings li.is-gap")).map((li) => li.querySelector("strong")?.textContent);
    expect(items.length).toBeGreaterThan(0);
    expect(document.querySelector(".onb-sev")).toBeTruthy();
    expect(screen.getAllByText(/Cannot be fixed by the PR\. Needs a person with access\./).length).toBeGreaterThan(0);
  });

  it("shows the live checks of the last verification, a check that could not be made apart from one that failed", async () => {
    const r = repo("web-storefront", (x) => {
      x.onboarding.verification = live([
        { id: "installation", label: "App installed", ok: true, detail: "Installed at organisation level." },
        { id: "bypass", label: "The App is not on any bypass list", ok: false, detail: "The Gantry App is on a bypass list." },
        { id: "canary", label: "Canary", ok: false, unknown: true, detail: "GitHub did not answer." },
      ]);
    });
    api([r]);
    mount(<OnboardingView />);
    await open("web-storefront");
    fireEvent.click(await byId("onb-dtab-findings"));
    const live_ = await byId("onb-live-checks");
    const rows = Array.from(live_.querySelectorAll("li")).map((li) => li.textContent);
    expect(rows[0]).toMatch(/App installedholds/);
    expect(rows[1]).toMatch(/bypass listfails.*on a bypass list/);
    expect(rows[2]).toMatch(/could not be checked/);
    expect(document.querySelector(".sub-h")?.textContent).toBeTruthy();
  });

  it("a readiness halt is explained on the repo", async () => {
    const r = repo("search-indexer", (x) => { x.halted = { by: "system", at: NOW, reason: "Readiness lost. The Gantry App is on a bypass list." }; });
    api([r]);
    mount(<OnboardingView />);
    await open("search-indexer");
    expect((await byId("onb-halt")).textContent).toMatch(/Halted: readiness was lost.*bypass list/);
  });

  it("Approve and merge is locked until the checks are green and the stage allows it, then asks the API once", async () => {
    const pending = repo("mobile-app", (r) => { r.onboarding.pr!.checks = "running"; r.onboarding.stage = "pr_checks"; });
    const calls = api([pending, GREEN].map((r, i) => (i ? { ...r, id: "other", name: "acme/other" } : r)), {
      "POST /api/v1/repos/other/onboarding/merge": () => ok("Merge of acme/other#338 requested."),
    });
    mount(<OnboardingView />);
    await open("mobile-app");
    expect(locked("onb-act-merge")).toBe("Checks are not green yet");
    fireEvent.click(document.getElementById("onb-act-merge")!);
    expect(posts(calls, "POST", "/api/v1/repos/mobile-app/onboarding/merge")).toHaveLength(0);
    cleanup();
    mount(<OnboardingView />);
    await open("other");
    expect(locked("onb-act-merge")).toBeNull();
    fireEvent.click(document.getElementById("onb-act-merge")!);
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/other/onboarding/merge")).toHaveLength(1));
    expect(await screen.findByText("Merge of acme/other#338 requested.")).toBeTruthy();
  });

  it("a person without the merge right sees the button locked with the reason; busy work is shown and blocks further actions", async () => {
    const r = repo("mobile-app", (x) => { x.onboarding.pr!.checks = "green"; x.onboarding.stage = "pr_checks"; x.onboarding.busy = "merging"; });
    api([r], {}, { denied: ["onboarding.merge"] });
    mount(<OnboardingView />);
    await open("mobile-app");
    await waitFor(() => expect(locked("onb-act-merge")).toMatch(/No role holds it/));
    expect((await byId("onb-busy")).textContent).toMatch(/GitHub is being asked to merge/);
    expect(locked("onb-act-rerun")).toMatch(/GitHub is being asked to merge/);
  });

  it("re-run, open PR, verify and request changes call the API with what the server expects", async () => {
    const assessed = repo("web-storefront", (x) => { x.onboarding.stage = "assessed"; x.onboarding.pr = null; x.onboarding.exception = null; delete x.onboarding.readyAt; x.onboarding.findings = clone(find("mobile-app").onboarding.findings); });
    const calls = api([assessed, GREEN], {
      "POST /api/v1/repos/web-storefront/onboarding/assess": () => ok("Assessment re-run for acme/web-storefront."),
      "POST /api/v1/repos/web-storefront/onboarding/open-pr": () => ok("The Onboarding agent is opening the PR on acme/web-storefront."),
      "POST /api/v1/repos/mobile-app/onboarding/request-changes": () => ok("Change requested. The Onboarding agent will update the pull request."),
    });
    mount(<OnboardingView />);
    await open("web-storefront");
    fireEvent.click(document.getElementById("onb-act-rerun")!);
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/web-storefront/onboarding/assess")).toHaveLength(1));
    fireEvent.click(document.getElementById("onb-act-openpr")!);
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/web-storefront/onboarding/open-pr")).toHaveLength(1));
    cleanup();
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(document.getElementById("onb-act-changes")!);
    const dlg = await screen.findByRole("dialog", { name: /Request changes on acme\/mobile-app#338/ });
    const text = within(dlg).getByRole("textbox");
    fireEvent.change(text, { target: { value: "no" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Request changes" }));
    expect(posts(calls, "POST", "/api/v1/repos/mobile-app/onboarding/request-changes")).toHaveLength(0);
    fireEvent.change(text, { target: { value: "Keep CODEOWNERS to /internal only" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/mobile-app/onboarding/request-changes")).toHaveLength(1));
    expect(posts(calls, "POST", "/api/v1/repos/mobile-app/onboarding/request-changes")[0]!.body).toMatchObject({ text: "Keep CODEOWNERS to /internal only" });
  });

  it("Verify now appears after the merge and calls verify; Re-check now for a Ready repo", async () => {
    const merged = repo("web-storefront", (x) => { x.onboarding.stage = "pr_merged"; x.onboarding.exception = null; });
    const calls = api([merged, find("notifications")], {
      "POST /api/v1/repos/web-storefront/onboarding/verify": () => ok("Verifying acme/web-storefront against GitHub."),
    });
    mount(<OnboardingView />);
    await open("web-storefront");
    fireEvent.click(await byId("onb-act-verify"));
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/web-storefront/onboarding/verify")).toHaveLength(1));
    cleanup();
    mount(<OnboardingView />);
    await open("notifications");
    expect(document.getElementById("onb-act-verify")?.textContent).toMatch(/Re-check now/);
  });

  it("marking an exception needs 10 characters and sends the reason; a Ready repo cannot be marked again", async () => {
    const calls = api([find("search-indexer"), find("web-storefront")], { "POST /api/v1/repos/search-indexer/onboarding/exception": () => ok("acme/search-indexer marked ready by exception.") });
    mount(<OnboardingView />);
    await open("search-indexer");
    fireEvent.click(document.getElementById("onb-act-exception")!);
    const dlg = await screen.findByRole("dialog", { name: /Mark acme\/search-indexer ready by exception/ });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "too short" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark ready" }));
    expect(posts(calls, "POST", "/api/v1/repos/search-indexer/onboarding/exception")).toHaveLength(0);
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Owner accepts the missing ruleset for now" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(posts(calls, "POST", "/api/v1/repos/search-indexer/onboarding/exception")).toHaveLength(1));
    expect(posts(calls, "POST", "/api/v1/repos/search-indexer/onboarding/exception")[0]!.body).toMatchObject({ reason: "Owner accepts the missing ruleset for now" });
    cleanup();
    mount(<OnboardingView />);
    await open("web-storefront");
    expect(locked("onb-act-exception")).toBe("Already ready");
  });

  it("the pull request tab shows the real files with their added lines, the link and the checks", async () => {
    api([GREEN], {
      "GET /api/v1/repos/mobile-app/onboarding/pr": () => ({ body: { number: 338, files: [{ path: "AGENTS.md", plus: 3, minus: 0, finding: "agents", mode: "create", added: ["# AGENTS.md", "## Test command", "Run `npm test`."] }] } }),
    });
    GREEN.onboarding.pr!.files = [{ path: "AGENTS.md", plus: 3, minus: 0, finding: "agents" }];
    mount(<OnboardingView />);
    await open("mobile-app");
    expect((await byId("onb-pr-link")).getAttribute("href")).toBe("https://github.test/acme/mobile-app/pull/338");
    const file = await byId("onb-file-AGENTS-md");
    fireEvent.click(file.querySelector("summary")!);
    await waitFor(() => expect(file.querySelector(".onb-diff")?.textContent).toContain("+ Run `npm test`."));
    expect(document.querySelector(".checklist li")?.textContent).toMatch(/passed/);
    expect(document.querySelector(".onb-pr .footnote")?.textContent).toMatch(/lines shown are what the pull request adds/);
  });

  it("the timeline lists real events, newest first, with CI named plainly", async () => {
    const r = clone(GREEN);
    r.onboarding.timeline = [{ at: NOW - 3000, who: "ag-onboard", text: "Opened PR #338 with 3 files." }, { at: NOW - 1000, who: "ci", text: "Checks on PR #338: all passed." }];
    api([r]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-timeline"));
    const rows = Array.from(document.querySelectorAll(".onb-timeline li")).map((li) => li.textContent);
    expect(rows[0]).toMatch(/CI.*all passed/);
    expect(rows[1]).toMatch(/Opened PR #338/);
    expect(rows[0]).not.toMatch(/simulated/i);
  });
});

describe("Onboarding: settings", () => {
  it("saves repo settings with the repo's version as If-Match, in the shape the server takes", async () => {
    const calls = api([find("web-storefront")], { "PATCH /api/v1/repos/web-storefront/config": () => ok("Saved acme/web-storefront.") });
    mount(<OnboardingView />);
    await open("web-storefront");
    fireEvent.click(document.getElementById("onb-act-settings")!);
    fireEvent.change(await byId("onb-w-branch"), { target: { value: "trunk" } });
    fireEvent.change(document.getElementById("onb-w-checks")!, { target: { value: "ci/test, ci/lint" } });
    fireEvent.change(document.getElementById("onb-w-paths")!, { target: { value: "infra/**\n.github/workflows/**" } });
    fireEvent.change(document.getElementById("onb-w-merge")!, { target: { value: "rebase" } });
    fireEvent.click(document.getElementById("onb-set-save")!);
    await waitFor(() => expect(posts(calls, "PATCH", "/api/v1/repos/web-storefront/config")).toHaveLength(1));
    const c = posts(calls, "PATCH", "/api/v1/repos/web-storefront/config")[0]!;
    expect(c.headers["if-match"]).toBe("5");
    expect(c.body).toMatchObject({ team: find("web-storefront").team, triggers: expect.any(Boolean), source: find("web-storefront").source, config: { defaultBranch: "trunk", merge: "rebase", requiredChecks: ["ci/test", "ci/lint"], protectedPaths: ["infra/**", ".github/workflows/**"] } });
  });

  it("shows the server's refusal inline when settings are stale", async () => {
    api([find("web-storefront")], { "PATCH /api/v1/repos/web-storefront/config": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    mount(<OnboardingView />);
    await open("web-storefront");
    fireEvent.click(document.getElementById("onb-act-settings")!);
    fireEvent.click(await byId("onb-set-save"));
    await waitFor(() => expect(document.querySelector(".form-err")?.textContent).toMatch(/changed since you loaded/));
  });
});

describe("Onboarding: the agent and its guidelines", () => {
  const agent = SEED.agents.find((a) => a.id === "ag-onboard")!;
  const tab = async (extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}, denied: string[] = [], project: Partial<Project> = {}) => {
    const calls = api([find("web-storefront")], { "GET /api/v1/projects": () => ({ body: [{ ...STOREFRONT, ...project }] }), "GET /api/v1/agents": () => ({ body: [agent] }), "GET /api/v1/skills": () => ({ body: SEED.skills }), ...extra }, { denied });
    window.history.replaceState(null, "", "/?tab=guidelines&edit=1"); // the versioned editor and the agent profile open from `?edit=1`, not from a button the Blueprint lacks
    mount(<OnboardingView />);
    await byId("onb-gl-save");
    return calls;
  };

  it("shows the agent, its skills in order, the versions and the guideline items from the server", async () => {
    await tab();
    expect(screen.getAllByText(agent.name).length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelectorAll(".onb-skills li").length).toBeGreaterThan(0));
    expect(document.querySelectorAll(".onb-gl-items li").length).toBeGreaterThanOrEqual(GUIDELINES.items.length);
    expect(document.querySelector(".onb-vers li .mono")?.textContent).toBe("v3");
    expect((document.getElementById("onb-gl-t-gl-1") as HTMLInputElement).value).toBe(GUIDELINES.items[0]!.text);
  });

  it("saves a new version with the current version as If-Match once something changed and a note is given", async () => {
    const calls = await tab({ "PUT /api/v1/guidelines": () => ok("Guidelines saved as v4.") });
    expect(locked("onb-gl-save")).toBe("No unsaved changes");
    expect(locked("onb-gl-reset")).toBe("No unsaved changes");
    fireEvent.change(document.getElementById("onb-gl-t-gl-1")!, { target: { value: "CI runs on every PR, main and tags." } });
    await waitFor(() => expect(locked("onb-gl-save")).toBeNull());
    expect(document.getElementById("onb-gl-save")!.textContent).toBe("Save as v4");
    fireEvent.click(document.getElementById("onb-gl-add")!);
    fireEvent.click(document.getElementById("onb-gl-save")!);
    await waitFor(() => expect(document.getElementById("onb-gl-err")!.textContent).toBe("Every item needs text, or remove it."));
    fireEvent.click(document.querySelector(".onb-gl-items li:last-child .btn")!);
    fireEvent.click(document.getElementById("onb-gl-save")!);
    await waitFor(() => expect(document.getElementById("onb-gl-err")!.textContent).toBe("Add a short change note."));
    fireEvent.change(document.getElementById("onb-gl-note")!, { target: { value: "Run on tags" } });
    fireEvent.click(document.getElementById("onb-gl-save")!);
    await waitFor(() => expect(posts(calls, "PUT", "/api/v1/guidelines")).toHaveLength(1));
    const put = posts(calls, "PUT", "/api/v1/guidelines")[0]!;
    expect(put.headers["if-match"]).toBe("3");
    expect(put.body).toMatchObject({ note: "Run on tags", patch: { items: expect.arrayContaining([{ id: "gl-1", text: "CI runs on every PR, main and tags.", required: true }]), may: GUIDELINES.may, mayNot: GUIDELINES.mayNot } });
  });

  it("discarding returns to the saved version; a stale save shows the server's refusal", async () => {
    await tab({ "PUT /api/v1/guidelines": () => ({ status: 409, body: { ok: false, msg: "This changed since you loaded it. Reload and try again." } }) });
    fireEvent.change(document.getElementById("onb-gl-t-gl-1")!, { target: { value: "changed" } });
    fireEvent.click(await byId("onb-gl-reset"));
    await waitFor(() => expect((document.getElementById("onb-gl-t-gl-1") as HTMLInputElement).value).toBe(GUIDELINES.items[0]!.text));
    fireEvent.change(document.getElementById("onb-gl-t-gl-1")!, { target: { value: "changed again" } });
    fireEvent.change(document.getElementById("onb-gl-note")!, { target: { value: "Try" } });
    fireEvent.click(document.getElementById("onb-gl-save")!);
    await waitFor(() => expect(document.getElementById("onb-gl-err")!.textContent).toMatch(/changed since you loaded/));
  });

  it("without agent.edit the factory guidelines are read-only with the reason", async () => {
    await tab({}, ["agent.edit"]);
    await waitFor(() => expect((document.getElementById("onb-gl-t-gl-1") as HTMLInputElement).disabled).toBe(true));
    expect(locked("onb-gl-save")).toMatch(/No role holds it/);
    expect(locked("onb-gl-add")).toMatch(/No role holds it/);
  });

  it("saves a project's additions with the project guideline version as If-Match", async () => {
    const calls = await tab({ "PUT /api/v1/projects/storefront/guidelines": () => ok("Storefront guidelines saved as v2.") }, [], {
      guidelines: { items: [{ id: "pg-1", text: "Model code changes need a signed model card.", required: true }], notes: "Regulated.", version: 1, history: [{ v: 1, at: NOW - 1000, by: "p-nikhil", note: "First version" }] },
    });
    expect(document.querySelector(".onb-gl-panel .mono.small.muted")?.textContent).toBeTruthy();
    fireEvent.change(await byId("onb-pg-t-pg-1"), { target: { value: "Model changes need a signed card in /models/cards." } });
    fireEvent.change(document.getElementById("onb-pg-note")!, { target: { value: "Clarify the path" } });
    fireEvent.click(document.getElementById("onb-pg-save")!);
    await waitFor(() => expect(posts(calls, "PUT", "/api/v1/projects/storefront/guidelines")).toHaveLength(1));
    const put = posts(calls, "PUT", "/api/v1/projects/storefront/guidelines")[0]!;
    expect(put.headers["if-match"]).toBe("1");
    expect(put.body).toMatchObject({ note: "Clarify the path", patch: { items: [{ id: "pg-1", text: "Model changes need a signed card in /models/cards.", required: true }], notes: "Regulated." } });
  });
});

void DEFAULT_CATALOG;

describe("Onboarding: who did the work, said honestly", () => {
  const assessedRepo = (patch: (r: Repo & { version: number }) => void) => repo("mobile-app", (r) => { r.onboarding.stage = "assessed"; r.onboarding.pr = null; r.onboarding.busy = null; r.onboarding.findings = [
    { id: "ci", check: "CI runs tests", ok: false, sev: "high", fix: "Add a workflow", file: ".github/workflows/gantry-ci.yml", required: true, detail: "No workflow" },
    { id: "test", check: "Test command", ok: true, sev: "high", fix: "", file: null, required: true, detail: "npm test (package.json scripts.test)" },
  ]; patch(r); });
  const agentAssessor = { mode: "agent" as const, agent: "ag-onboard", version: 2, model: "claude-sonnet-5-5", runId: "r-abc123", skills: { "sk-assess": 1, "sk-onboardpr": 1 }, costUsd: 0.12, tokens: 9000, risk: { level: "medium" as const, reason: "No CI and no owners." }, summary: "Two gaps." };

  it("a rule-based assessment says so, with the reason, and every finding is badged as observed; older data with no record reads the same way", async () => {
    const r = assessedRepo((x) => { x.onboarding.adapter = "rule-based"; x.onboarding.assessor = { mode: "rule-based", reason: "No connected vendor serves claude-sonnet-5-5." }; });
    api([r]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-findings"));
    const a = await byId("onb-assessor");
    expect(a.textContent).toContain("Assessed by: rule-based (no agent)");
    expect(a.textContent).toContain("No connected vendor serves claude-sonnet-5-5.");
    expect(a.textContent).not.toMatch(/Onboarding Agent v/);
    expect(document.querySelectorAll(".onb-findings .onb-src").length).toBe(r.onboarding.findings.length);
    expect(Array.from(document.querySelectorAll(".onb-findings .onb-src")).every((e) => e.textContent === "Observed")).toBe(true);
    cleanup();
    const old = assessedRepo((x) => { delete x.onboarding.assessor; x.onboarding.adapter = "stub"; });
    api([old]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-findings"));
    expect((await byId("onb-assessor")).textContent).toContain("Assessed by: rule-based (no agent)");
  });

  it("an agent assessment names the agent, version, model, skills, run and cost, shows the agent's notes under an Agent badge, and keeps the observed result", async () => {
    const r = assessedRepo((x) => {
      x.onboarding.adapter = "agent";
      x.onboarding.assessor = agentAssessor;
      x.onboarding.findings = x.onboarding.findings.map((f, i) => ({ ...f, source: "observed" as const, ...(i === 0 ? { note: "There is no workflow, so nothing runs on pull requests." } : {}) }));
    });
    api([r]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-findings"));
    const a = await byId("onb-assessor");
    expect(a.textContent).toContain("Assessed by: Onboarding Agent v2 · model claude-sonnet-5-5");
    expect(a.textContent).toContain("sk-assess v1, sk-onboardpr v1");
    expect(a.textContent).toContain("Run r-abc123");
    expect(a.textContent).toContain("$0.12");
    expect(a.textContent).toContain("Risk judged medium: No CI and no owners.");
    expect(a.textContent).toMatch(/observed result stands/);
    const notes = document.querySelectorAll(".onb-note");
    expect(notes.length).toBe(1);
    expect(notes[0]!.textContent).toContain("Agent");
    expect(notes[0]!.textContent).toContain("nothing runs on pull requests");
  });

  it("the pull request tab says who drafted it and badges each file as agent-drafted or observed", async () => {
    const r = repo("mobile-app", (x) => {
      x.onboarding.drafter = { ...agentAssessor, guidelineSuggestions: [] };
      x.onboarding.pr!.files = [{ path: "AGENTS.md", plus: 12, minus: 0, finding: "agents", source: "agent" }, { path: "CODEOWNERS", plus: 4, minus: 0, finding: "owners", source: "observed" }];
    });
    api([r]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-pr"));
    expect((await byId("onb-drafter")).textContent).toContain("Drafted by: Onboarding Agent v2 · model claude-sonnet-5-5");
    expect(document.getElementById("onb-file-AGENTS-md")!.querySelector(".onb-src")!.textContent).toBe("Agent");
    expect(document.getElementById("onb-file-CODEOWNERS")!.querySelector(".onb-src")!.textContent).toBe("Observed");
    cleanup();
    const rb = repo("mobile-app", (x) => { x.onboarding.drafter = { mode: "rule-based", reason: "The plan has no file an agent may draft." }; });
    api([rb]);
    mount(<OnboardingView />);
    await open("mobile-app");
    fireEvent.click(await byId("onb-dtab-pr"));
    expect((await byId("onb-drafter")).textContent).toContain("Drafted by: rule-based (no agent)");
  });

  it("names the agent in the busy line only while a run of it exists", async () => {
    const plain = repo("mobile-app", (x) => { x.onboarding.busy = "assessing"; x.onboarding.timeline = [{ at: NOW - 1000, who: "p-daniel", text: "Asked for a new assessment." }]; });
    api([plain]);
    mount(<OnboardingView />);
    await open("mobile-app").catch(() => undefined);
    expect((await byId("onb-busy")).textContent).toBe("Gantry is assessing the repo.");
    cleanup();
    const run = repo("mobile-app", (x) => { x.onboarding.busy = "assessing"; x.onboarding.timeline = [{ at: NOW - 1000, who: "ag-onboard", text: "Started the Onboarding Agent v2 (model claude-sonnet-5-5) to review the observed findings. Gantry's own observations stay the source of truth." }]; });
    api([run]);
    mount(<OnboardingView />);
    await open("mobile-app");
    expect((await byId("onb-busy")).textContent).toMatch(/The Onboarding Agent is working on this repo\. Run: Onboarding Agent v2 \(model claude-sonnet-5-5\)/);
  });
});

describe("Onboarding: the agent tab says when the agent cannot run", () => {
  const agent = SEED.agents.find((a) => a.id === "ag-onboard")!;
  const vendor = (connected: boolean, enabled = true) => ({ id: "anthropic", name: "Anthropic", connected, models: [{ id: agent.model, name: "Sonnet", enabled, canonical: agent.model }] });
  const tab = async (vendors: unknown, a = agent) => {
    api([find("web-storefront")], { "GET /api/v1/agents": () => ({ body: [a] }), "GET /api/v1/vendors": () => ({ body: vendors }) });
    window.history.replaceState(null, "", "/?tab=guidelines&edit=1"); // the versioned editor and the agent profile open from `?edit=1`, not from a button the Blueprint lacks
    mount(<OnboardingView />);
    await byId("onb-gl-save");
  };

  it("shows the banner, with the reason, when no connected vendor serves the model; the agent's real instructions and skills are listed", async () => {
    await tab([vendor(false)]);
    const b = await byId("onb-agent-off");
    expect(b.textContent).toContain("Onboarding runs rule-based until a model vendor is connected.");
    expect(b.textContent).toContain(`No connected vendor serves ${agent.model}.`);
    expect(document.getElementById("onb-agent-on")).toBeNull();
    expect(document.querySelector(".onb-instr")!.textContent).toBe(agent.instructions);
    expect(document.querySelectorAll(".onb-skills li").length).toBe(agent.skills.length);
  });

  it("shows no banner once a connected vendor serves the model, and a paused agent is reported as paused", async () => {
    await tab([vendor(true)]);
    expect((await byId("onb-agent-on")).textContent).toMatch(/never changes a finding, adds a file, or merges/);
    expect(document.getElementById("onb-agent-off")).toBeNull();
    cleanup();
    await tab([vendor(true)], { ...agent, status: "paused" });
    expect((await byId("onb-agent-off")).textContent).toContain("The Onboarding Agent is paused.");
  });
});
