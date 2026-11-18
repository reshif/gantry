/** Round 2 of the Blueprint match for Onboarding: the session of a repo that was not started or does not exist, Mark fixed, Mark checks passing, Settings, the pipeline's rows and tiles. */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devSeed, type Project, type Repo } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import OnboardingView from "./onboarding";
import { mockApi, mount, resetApp, type Call } from "./floor/testkit";

const SEED = devSeed(Date.now()).state;
const STOREFRONT = { ...(SEED.projects.find((p) => p.id === "storefront") as Project), version: 3 };
const RISK = { ...(SEED.projects.find((p) => p.id === "risk") as Project), version: 1 };
const daniel = SEED.people.find((p) => p.id === "p-daniel")!;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const mk = (id: string, patch: (r: Repo & { version: number }) => void) => { const r = clone(SEED.repos.find((x) => x.id === id)!) as Repo & { version: number }; r.version = 1; patch(r); return r; };
const ASSESSED = mk("mobile-app", (r) => { r.onboarding.stage = "assessed"; r.onboarding.pr = null; r.onboarding.findings = [{ id: "f1", check: "CI runs on every PR.", ok: false, required: true, sev: "high", fix: "Add a workflow", file: null }, { id: "f2", check: "Lint config is committed.", ok: true, required: false, sev: "low", fix: "", file: null }] as never; });
const PR_OPEN = mk("search-indexer", (r) => { r.onboarding.stage = "pr_opened"; r.onboarding.pr = { number: 4, state: "open", checks: "pending", url: null, files: [{ path: "AGENTS.md", plus: 1, minus: 0, finding: "", mode: "create", added: [] }] } as never; });
const READY = mk("web-storefront", (r) => { r.onboarding.stage = "ready"; });
const session = (r: Repo) => ({ repoId: r.id, repo: r.name, project: "storefront", messages: [{ id: "m1", role: "assistant", author: "ag-onboard", text: "I read it.", at: Date.now() - 1000, data: { mode: "agent" } }], agent: { mode: "agent", model: "m", vendor: "v", version: 3 }, budget: { spentUsd: 0.4, limitUsd: 5 }, costUsd: 0.4, can: { talk: true, merge: true, talkWhy: "" }, steps: [], next: { actor: "you", text: "review the findings" }, stage: r.onboarding.stage, busy: null, prNeedsUpdate: false, waiting: null, prChecks: null });
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

function api(repos: Array<Repo & { version: number }>, extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}) {
  return mockApi({
    "GET /api/v1/projects": () => ({ body: [STOREFRONT, RISK] }),
    "GET /api/v1/projects/storefront/repos": () => ({ body: repos }),
    "GET /api/v1/projects/risk/repos": () => ({ body: [READY, READY, READY].map((r, i) => ({ ...r, id: `risk-${i}` })) }),
    "GET /api/v1/projects/storefront/repos/available": () => ({ body: { available: [{ repo: "acme-internal/partner-reports", lang: "Python" }] } }),
    "GET /api/v1/guidelines": () => ({ body: { version: 3, by: "p-daniel", at: Date.now(), items: SEED.guidelines.items, may: "", mayNot: "x", history: [] } }),
    "GET /api/v1/teams": () => ({ body: [] }), "GET /api/v1/integrations": () => ({ body: [] }), "GET /api/v1/integration-types": () => ({ body: [] }), "GET /api/v1/audit": () => ({ body: [] }),
    ...Object.fromEntries(repos.map((r) => [`GET /api/v1/repos/${r.id}/onboarding/session`, () => ({ body: session(r) })])),
    ...extra,
  }, { me: { person: daniel, projects: [STOREFRONT, RISK] } });
}

beforeEach(() => { resetApp(); updatePrefs({ project: "storefront" }); });
afterEach(() => { window.history.replaceState(null, "", "/"); cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Onboarding fidelity round 2", () => {
  it("a repo that was not started opens with empty panels instead of crashing; an unknown repo says it does not exist", async () => {
    api([ASSESSED]);
    window.location.hash = "#/p/storefront/onboarding/acme-internal--partner-reports";
    mount(<OnboardingView />);
    expect(await screen.findByText("Assessment against guidelines")).toBeTruthy();
    expect(screen.getByText("Conversation with the Onboarding agent")).toBeTruthy();
    expect(document.querySelector("#osx-steps .on")?.textContent).toBe("1. Connect");
    cleanup();
    window.location.hash = "#/p/storefront/onboarding/nope--nothing";
    mount(<OnboardingView />);
    expect(await screen.findByText("That repo does not exist.")).toBeTruthy();
  });

  it("each gap has Mark fixed (it re-checks the repo) and no extra fix line; the conversation is bubbles without a Send button or Next line", async () => {
    const calls = api([ASSESSED], { "POST /api/v1/repos/mobile-app/onboarding/assess": () => ({ body: { ok: true, msg: "Assessing." } }) });
    window.location.hash = "#/p/storefront/onboarding/mobile-app";
    mount(<OnboardingView />);
    fireEvent.click(await byId("osx-fixed-f1"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/onboarding/assess"))).toBe(true));
    expect(document.getElementById("osx-fixed-f2")).toBeNull(); // a finding that is met has none
    expect(document.body.textContent).not.toMatch(/Add a workflow/);
    expect(document.getElementById("osx-send")).toBeNull();
    expect(document.getElementById("osx-next")).toBeNull();
    expect(screen.getByText("I read it.")).toBeTruthy();
  });

  it("the Pull request tab at the PR stage offers Mark checks passing", async () => {
    api([PR_OPEN]);
    window.history.replaceState(null, "", "/?tab=pr");
    window.location.hash = "#/p/storefront/onboarding/search-indexer";
    mount(<OnboardingView />);
    expect((await byId("osx-checks")).textContent).toBe("Mark checks passing");
  });

  it("Settings is a four-row panel titled Settings", async () => {
    api([ASSESSED]);
    window.history.replaceState(null, "", "/?tab=settings");
    window.location.hash = "#/p/storefront/onboarding/mobile-app";
    mount(<OnboardingView />);
    await byId("osx-details");
    expect(Array.from(document.querySelectorAll(".panel-title")).map((t) => t.textContent)).toEqual(["Settings"]);
    expect(Array.from(document.querySelectorAll(".kv dt")).map((t) => t.textContent)).toEqual(["Repository", "Language", "Project", "Default branch"]);
  });

  it("the pipeline lists only what is moving (no live repos), counts Pipeline by started repos, and Ready counts live repos of every project", async () => {
    api([ASSESSED, READY]);
    window.location.hash = "#/p/storefront/onboarding";
    mount(<OnboardingView />);
    await byId("onb-list");
    expect(document.querySelector("#onb-list .fbar .count")?.textContent).toBe("2 repos"); // the assessed one and the one waiting; the ready repo is not a row
    expect(document.querySelector("#onb-tab-pipeline .count, #onb-tab-pipeline .tab-count, #onb-tab-pipeline")?.textContent).toMatch(/1$/);
    await waitFor(() => expect(Array.from(document.querySelectorAll(".stats .stat")).find((s) => s.textContent?.includes("Ready"))?.textContent).toMatch(/4/)); // 1 in storefront + 3 in risk
    expect(document.querySelector("#onb-list-sort-select, .dtable-sortsel")).toBeNull(); // no Sort by select above the cards
  });

  it("the Guidelines panel has an Edit guidelines button that opens the versioned editor by click", async () => {
    api([ASSESSED]);
    window.history.replaceState(null, "", "/?tab=guidelines");
    window.location.hash = "#/p/storefront/onboarding";
    mount(<OnboardingView />);
    await byId("onb-gl-sw-" + SEED.guidelines.items[0]!.id);
    fireEvent.click(await byId("onb-gl-edit"));
    expect(await byId("onb-gl-save")).toBeTruthy(); // the editor (guideline text, agent instructions, versions) renders
  });
});
