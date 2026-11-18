import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devSeed, type Project, type Repo } from "@gantry/domain";
import { updatePrefs } from "../lib/prefs";
import OnboardingView from "./onboarding";
import { mockApi, mount, resetApp, type Call } from "./floor/testkit";

const SEED = devSeed(Date.now()).state;
const STOREFRONT = { ...(SEED.projects.find((p) => p.id === "storefront") as Project), version: 3 };
const daniel = SEED.people.find((p) => p.id === "p-daniel")!;
const NOW = Date.now();
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const REPO = (() => {
  const r = clone(SEED.repos.find((x) => x.id === "mobile-app")!) as Repo & { version: number };
  r.version = 5;
  r.onboarding.stage = "assessed";
  r.onboarding.pr = null;
  r.onboarding.busy = null;
  r.onboarding.timeline = [{ at: NOW - 5000, who: "system", text: "Assessment finished (rule-based (no agent)): 4 findings, 2 gaps." }];
  return r;
})();

const PROPOSAL = {
  kind: "proposal", id: "P-1", what: "open_pr", title: "Proposed onboarding PR", summary: "3 files that close the gaps Gantry observed.", mode: "agent", runId: "r1", status: "pending",
  files: [{ path: "AGENTS.md", mode: "create", finding: "agents", plus: 12, minus: 0, source: "agent", added: ["# Agents", "Run vitest run"] }, { path: "CODEOWNERS", mode: "create", finding: "owners", plus: 2, minus: 0, source: "observed", added: ["* @acme/growth"] }],
};
const session = (over: Record<string, unknown> = {}) => ({
  repoId: "mobile-app", repo: "acme/mobile-app", project: "storefront",
  messages: [{ id: "om-1", role: "assistant", author: "ag-onboard", text: "Gantry observed two gaps. I drafted AGENTS.md; it waits for your approval.", at: NOW - 3000, data: { mode: "agent", cards: [{ kind: "progress", text: "Read the repository: 40 files on main" }, { kind: "question", id: "Q-1", question: "How are the tests run?", options: ["make check", "vitest"] }, PROPOSAL] } }],
  agent: { mode: "agent", model: "claude-sonnet-5-5", vendor: "anthropic", version: 2 }, budget: { spentUsd: 0.12, limitUsd: 1 }, costUsd: 0.12, can: { talk: true, merge: false, talkWhy: "" },
  steps: [{ name: "Connected", state: "done" }, { name: "Assessed", state: "current" }, { name: "PR opened", state: "todo" }, { name: "Checks", state: "todo" }, { name: "Merged", state: "todo" }, { name: "Verified", state: "todo" }, { name: "Ready", state: "todo" }],
  next: { actor: "you", text: "review the proposed changes and approve, ask for changes or discard" }, stage: "assessed", busy: null, prNeedsUpdate: false, ...over,
});
const ok = (msg: string) => ({ body: { ok: true, msg } });
function api(s: ReturnType<typeof session>, extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}) {
  return mockApi({
    "GET /api/v1/projects": () => ({ body: [STOREFRONT] }),
    "GET /api/v1/projects/storefront/repos": () => ({ body: [REPO] }),
    "GET /api/v1/repos/mobile-app/onboarding/session": () => ({ body: s }),
    "GET /api/v1/guidelines": () => ({ body: { version: 1, by: "p-daniel", at: NOW, items: [], may: "", mayNot: "", history: [] } }),
    "GET /api/v1/teams": () => ({ body: [] }), "GET /api/v1/integrations": () => ({ body: [] }), "GET /api/v1/integration-types": () => ({ body: [] }), "GET /api/v1/audit": () => ({ body: [] }),
    ...extra,
  }, { me: { person: daniel, projects: [STOREFRONT] } });
}
const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });

beforeEach(() => { resetApp(); updatePrefs({ project: "storefront" }); window.history.replaceState(null, "", "/?tab=pipeline#/p/storefront/onboarding/mobile-app"); }); // one replaceState: assigning location.hash queues a hashchange that wipes ?tab=
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("Onboarding session", () => {
  it("shows the conversation with its cards, the lifecycle stepper, the Next line, cost and the pending proposal", async () => {
    api(session());
    mount(<OnboardingView />);
    expect(await screen.findByText(/Gantry observed two gaps/)).toBeTruthy();
    expect(screen.getByText("How are the tests run?")).toBeTruthy();
    expect(screen.getByText(/Read the repository: 40 files/)).toBeTruthy();
    expect(screen.getAllByText("Proposed onboarding PR").length).toBeGreaterThan(0);
    expect(screen.getByText("Drafted by the Onboarding Agent")).toBeTruthy();
    const steps = Array.from(document.querySelectorAll("#osx-steps li")).map((li) => [li.textContent, li.className]);
    expect(steps[0]).toEqual(["Connected", "is-done"]);
    expect(steps[1]).toEqual(["Assessed", "is-current"]);
    expect(document.querySelector("#osx-next")?.textContent).toMatch(/You — review the proposed changes/);
    expect(document.getElementById("osx-cost")?.textContent).toMatch(/\$0\.12.*\$1\.00 budget/);
    expect(document.querySelector("#osx-pending")?.textContent).toMatch(/Proposed onboarding PR · 2 files/);
    expect(document.getElementById("osx-findings")?.textContent).toMatch(/Observed/);
    fireEvent.click(screen.getByText("AGENTS.md").closest("button")!);
    expect(screen.getByLabelText("Added lines of AGENTS.md").textContent).toContain("+ Run vitest run");
  });

  it("Approve calls the decision endpoint for that proposal; Discard likewise; Ask for changes sends the words and then asks the agent to continue", async () => {
    const calls = api(session(), {
      "POST /api/v1/repos/mobile-app/onboarding/session/proposals/om-1/P-1": () => ok("Gantry is opening the PR."),
      "POST /api/v1/repos/mobile-app/onboarding/session/messages": () => ok("Saved."),
    });
    mount(<OnboardingView />);
    fireEvent.click(await byId("osx-approve-P-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/proposals/om-1/P-1") && c.body?.decision === "approve")).toBe(true));
    fireEvent.click(await byId("osx-discard-P-1"));
    await waitFor(() => expect(calls.some((c) => c.body?.decision === "discard")).toBe(true));
    fireEvent.click(await byId("osx-changes-P-1"));
    fireEvent.change(await byId("osx-changes-text-P-1"), { target: { value: "tests run with make check" } });
    fireEvent.click(await byId("osx-changes-send-P-1"));
    await waitFor(() => expect(calls.some((c) => c.body?.decision === "changes" && c.body?.text === "tests run with make check")).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/session/messages") && c.body?.kind === "continue")).toBe(true));
  });

  it("an agent-authored PR lists the sensitive parts and the diff cap; Approve stays disabled until they are confirmed, then sends confirmSensitive", async () => {
    const s = clone(session()) as any;
    const card = s.messages[0].data.cards.find((c: any) => c.kind === "proposal");
    card.sensitive = [{ id: "workflow", label: "CI workflow", paths: [".github/workflows/ci.yml"], reason: "A workflow runs code on GitHub's runners." }, { id: "dependencies", label: "Dependency manifest", paths: ["pyproject.toml"], reason: "Adds a dependency manifest." }];
    card.blockers = [{ id: "workflow_permission", message: "The Gantry GitHub App is not allowed to write workflow files.", fix: "Set Workflows to Read and write." }];
    card.diffCap = 1500;
    const calls = api(s, { "POST /api/v1/repos/mobile-app/onboarding/session/proposals/om-1/P-1": () => ok("Gantry is opening the PR.") });
    mount(<OnboardingView />);
    const approve = await byId("osx-approve-P-1");
    expect(screen.getByText(/Needs your explicit confirmation/)).toBeTruthy();
    expect(screen.getByText(/not allowed to write workflow files/)).toBeTruthy();
    expect(screen.getByText(/cap 1500 lines/)).toBeTruthy();
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await byId("osx-confirm-P-1"));
    await waitFor(() => expect((document.getElementById("osx-approve-P-1") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(document.getElementById("osx-approve-P-1")!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/proposals/om-1/P-1") && c.body?.decision === "approve" && c.body?.confirmSensitive === true)).toBe(true));
  });

  it("answering a question or typing sends a message", async () => {
    const calls = api(session(), { "POST /api/v1/repos/mobile-app/onboarding/session/messages": () => ok("Saved.") });
    mount(<OnboardingView />);
    fireEvent.click(await screen.findByRole("button", { name: "make check" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/session/messages") && c.body?.text === "make check" && c.body?.kind === "message")).toBe(true));
  });

  it("without a model it says so: rule-based labels, a composer that points to connecting a vendor, and the same Approve", async () => {
    const rule = { ...PROPOSAL, mode: "rule-based" };
    api(session({ agent: { mode: "rule-based", reason: "No model is configured." }, messages: [{ id: "om-1", role: "system", author: "system", text: "Gantry assessed acme/mobile-app (rule-based, no agent): 4 checks, 2 gaps.", at: NOW - 3000, data: { mode: "rule-based", cards: [rule] } }], next: { actor: "you", text: "review the proposed changes and approve, ask for changes or discard" } }));
    mount(<OnboardingView />);
    expect((await screen.findAllByText(/Rule-based \(no agent\)/)).length).toBeGreaterThan(1);
    expect((await byId("osx-input")).getAttribute("placeholder")).toBe("Connect a model vendor to talk to the Onboarding Agent");
    expect(document.getElementById("osx-mode-note")?.textContent).toMatch(/Connect a model vendor to talk to the Onboarding Agent/);
    expect((document.getElementById("osx-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((await byId("osx-approve-P-1")).hasAttribute("disabled")).toBe(false);
  });

  it("a viewer reads the thread but cannot approve or type; a merge proposal explains who may merge", async () => {
    const merge = { ...PROPOSAL, id: "P-2", what: "merge", title: "Merge PR #338", files: [] };
    api(session({ can: { talk: true, merge: false, talkWhy: "" }, messages: [{ id: "om-2", role: "assistant", author: "ag-onboard", text: "Checks are green.", at: NOW - 100, data: { mode: "agent", cards: [merge] } }] }));
    mount(<OnboardingView />);
    const b = await byId("osx-approve-P-2");
    expect(b.textContent).toBe("Approve and merge");
    expect(b.getAttribute("aria-disabled") === "true" || b.hasAttribute("disabled")).toBe(true);
    cleanup();
    api(session({ can: { talk: false, merge: false, talkWhy: "You hold no role that manages onboarding." } }));
    mount(<OnboardingView />);
    expect((await byId("osx-approve-P-1")).hasAttribute("disabled")).toBe(true);
    expect((document.getElementById("osx-input") as HTMLTextAreaElement).placeholder).toMatch(/Read-only/);
  });

  it("starts by itself on an assessed repo with no conversation yet", async () => {
    const calls = api(session({ messages: [] }), { "POST /api/v1/repos/mobile-app/onboarding/session/messages": () => ok("Posted.") });
    mount(<OnboardingView />);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/session/messages") && c.body?.kind === "open")).toBe(true));
  });

  it("a repo opens its session from the drawer, and from the Session tab", async () => {
    window.history.replaceState(null, "", "/?tab=pipeline#/p/storefront/onboarding"); // not location.hash: that queues a hashchange which wipes ?tab=
    api(session());
    mount(<OnboardingView />);
    fireEvent.click(await byId("onb-detail-mobile-app"));
    fireEvent.click(await byId("onb-act-session"));
    await waitFor(() => expect(window.location.hash).toMatch(/onboarding\/mobile-app$/));
    expect(await screen.findByText(/Gantry observed two gaps/)).toBeTruthy();
  });

  it("shows what the thread waits on as a chip instead of asking the person to ask again, and clears the bell by marking the session seen", async () => {
    const calls = api(session({ waiting: { text: "Waiting for CI on PR #2", since: NOW - 120_000, checkedAt: NOW - 60_000 } }), { "POST /api/v1/repos/mobile-app/onboarding/session/seen": () => ok("Seen.") });
    mount(<OnboardingView />);
    const chip = await byId("osx-waiting");
    expect(chip.textContent).toMatch(/Waiting for CI on PR #2 since .*checked .*we'll post here and notify you/);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/session/seen"))).toBe(true));
  });
});
