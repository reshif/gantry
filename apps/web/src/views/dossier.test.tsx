import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import ChangesView from "./changes";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

async function show(extra: Parameters<typeof mockApi>[0] = {}, hash = `#record/${W.id}/journey`) {
  const calls = mockApi({ ...readsFor(W), ...extra });
  window.location.hash = hash;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Work order page", () => {
  it("puts the title, route and actions in the header and the prototype tabs under it, with Prompts before Events", async () => {
    await show({}, `#record/${W.id}/journey`);
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(screen.getByRole("list", { name: new RegExp(`Route of ${W.id}`) })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Journey", "Gates", "Attempts and runs", "Conversation", "Cost", "Prompts", "Events"]);
    expect(screen.getByRole("tab", { name: "Journey" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dz-more")).toBeTruthy();
    // the conversation is a tab, not a header button
    expect(document.getElementById("trv-open-conversation")).toBeNull();
  });

  it("lists the header actions in the prototype's order and sends Traveler, Dossier and Changes to their pages", async () => {
    await show({}, `#record/${W.id}`);
    const labels = [...document.querySelectorAll('[role="toolbar"] button')].map((b) => b.textContent?.trim());
    expect(labels.slice(0, 3)).toEqual(["Traveler", "Dossier", "Changes"]);
    expect(labels[labels.length - 1]).toBe("Actions");
    expect(labels.some((l) => /^Review /.test(l ?? ""))).toBe(true);
    expect(labels).not.toContain("Open conversation");
    expect(document.getElementById("rec-all")).toBeNull();
    fireEvent.click(document.getElementById("rec-dossier") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`dossier/${W.id}`));
    fireEvent.click(document.getElementById("rec-changes") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`changes/${W.id}`));
  });

  it("opens the Traveler drawer from the Traveler button, with its tabs and ?traveler= in the URL, and reaches the printable page from inside it", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("rec-traveler") as HTMLElement);
    for (const t of ["journey", "documents", "history"]) await waitFor(() => expect(document.getElementById(`trv-tab-${t}`)).toBeTruthy());
    await waitFor(() => expect(window.location.search).toContain(`traveler=${W.id}`));
    expect(window.location.hash).not.toContain("traveler/");
    fireEvent.click(document.getElementById("trv-open-page") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`traveler/${W.id}`));
  });

  it("has the prototype's Actions menu: edit, reassign, park, send back, a divider and stop", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("dz-more") as HTMLElement);
    const items = (await screen.findAllByRole("menuitem")).map((i) => (i.textContent ?? "").replace(/locked$/, "").trim());
    expect(items).toEqual(["Edit title and priority", "Reassign", "Park", "Send back a station", "Redo this station", "Stop this work order\u2026"]);
    expect(document.querySelectorAll('[role="menu"] hr, [role="menu"] [role="separator"]').length).toBe(1);
    expect(document.getElementById("dz-more")?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("opens the prototype's dialogs from the Actions menu: Edit, Reassign, Park (one reason), Send back and Stop", async () => {
    await show({}, `#record/${W.id}`);
    const open = async (item: string) => {
      fireEvent.click(document.getElementById("dz-more") as HTMLElement);
      fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(`^${item}`) }));
    };
    await open("Edit title and priority");
    expect(await screen.findByRole("dialog", { name: `Edit ${W.id}` })).toBeTruthy();
    for (const l of ["Title", "Priority", "Class"]) expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("Reassign");
    expect(await screen.findByRole("dialog", { name: `Reassign ${W.id}` })).toBeTruthy();
    expect(screen.getByText("New owner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("Park");
    expect(await screen.findByRole("dialog", { name: `Park ${W.id}` })).toBeTruthy();
    expect(screen.getByText("It stops moving until someone resumes it.")).toBeTruthy();
    expect(screen.queryByText("Bay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("Send back a station");
    expect(await screen.findByRole("dialog", { name: /^Send WO-.* back to / })).toBeTruthy();
    expect(screen.getByText("The previous agent re-runs with your note.")).toBeTruthy();
    expect(screen.queryByText("Back to station")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("Stop this work order");
    expect(await screen.findByRole("dialog", { name: `Stop ${W.id}?` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop work order" })).toBeTruthy();
  });

  it("leaves the page for the work orders list after a valid Stop, as the prototype does", async () => {
    await show({ "POST /api/v1/stops": () => ({ body: { ok: true } }) }, `#/p/payments/record/${W.id}`);
    fireEvent.click(document.getElementById("dz-more") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Stop this work order/ }));
    await screen.findByRole("dialog", { name: `Stop ${W.id}?` });
    fireEvent.change(document.getElementById("wo-stop-reason") as HTMLElement, { target: { value: "Bad data in the brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop work order" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/work-orders"));
  });

  it("shows the blocked reason in the Overview's right column as \"Blocked.\", not above the tabs", async () => {
    await show({ ...readsFor(W, travelerOf(W, { blockReason: "Waiting on the schema owner" })) }, `#record/${W.id}`);
    const b = await screen.findByText("Blocked.");
    expect(b.closest("#dz-blocked")?.textContent).toContain("Waiting on the schema owner");
    expect(b.closest("#dz-overview")).toBeTruthy();
  });

  it("marks the current station's dot blue even at a gate, with a Gate chip", async () => {
    await show({}, `#record/${W.id}/journey`);
    const cur = document.querySelector("#dz-journey .tl > .info");
    expect(cur?.textContent).toContain("Gate");
    expect(document.querySelector("#dz-journey .tl > .warn")).toBeNull();
  });

  it("opens the Edit dialog from the Brief card's Edit button", async () => {
    await show({}, `#record/${W.id}`);
    expect(screen.getByText("Click the description to edit it")).toBeTruthy();
    fireEvent.click(document.getElementById("dz-edit") as HTMLElement);
    expect(await screen.findByRole("dialog", { name: `Edit ${W.id}` })).toBeTruthy();
  });

  it("makes the description editable in place", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("dz-desc") as HTMLElement);
    expect(await screen.findByLabelText("Edit description")).toBeTruthy();
  });

  it("opens the review dialog from Review and offers Request changes, Reject and Approve", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(document.getElementById("trv-approve") as HTMLElement);
    expect(await screen.findByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/Add a comment of at least 10 characters/)).toBeTruthy();
  });

  it("opens on the Overview tab: brief, classification, facts and SLA", async () => {
    await show({}, `#record/${W.id}`);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("dz-overview")).toBeTruthy();
    for (const t of ["Brief", "Classification", "Facts"]) expect(screen.getByRole("heading", { name: t })).toBeTruthy();
    // Where and Requested by live in the header, not in Facts
    expect(document.querySelector("#dz-overview dl")?.textContent).not.toMatch(/Requested by/);
  });

  it("keeps the old addresses working: activity opens Conversation, document opens Journey", async () => {
    await show({}, `#record/${W.id}/activity`);
    expect(screen.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/document`);
    expect(screen.getByRole("tab", { name: "Journey" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the tab in the address", async () => {
    await show({}, `#record/${W.id}`);
    fireEvent.click(screen.getByRole("tab", { name: "Gates" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=gates"));
    expect(window.location.hash).not.toContain("%2F");
    expect(screen.getByRole("tab", { name: "Gates" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: "Gates" })).toBeTruthy();
    for (const c of ["Gate", "Mode", "Status", "Decided by", "When"]) expect(screen.getAllByText(c).length).toBeGreaterThan(0);
    // stacked small-screen cards say "By", as the prototype does
    expect(document.querySelector('#dz-gates-table td[data-l="By"]')).toBeTruthy();
  });

  it("shows the Journey timeline, the attempts table, the cost by station and the events", async () => {
    await show({}, `#record/${W.id}/journey`);
    expect(screen.getByRole("heading", { name: "Journey" })).toBeTruthy();
    expect(document.querySelector("#dz-journey .tl")).toBeTruthy();
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/attempts`);
    expect(await screen.findByRole("heading", { name: "Attempts and runs" })).toBeTruthy();
    for (const c of ["Attempt", "Station", "Outcome", "Duration", "Tokens", "Model"]) expect(screen.getAllByText(c).length).toBeGreaterThan(0);
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/costs`);
    expect(await screen.findByRole("heading", { name: "Cost by station" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tokens" })).toBeTruthy();
    cleanup();
    resetApp();
    await show({}, `#record/${W.id}/events`);
    expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
  });

  it("has no lock banners and no waiting-on-you control beside the tabs", async () => {
    await show();
    expect(document.querySelector(".dz-lockline")).toBeNull();
    expect(screen.queryByText(/Waiting on you/)).toBeNull();
  });

  it("shows a Not found page with the way back when the work order is not visible", async () => {
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 403, body: { ok: false, msg: "No." } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    expect(await screen.findByRole("heading", { name: "Not found" }, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to work orders" }));
    await waitFor(() => expect(window.location.hash).toContain("work-orders"));
  });
});

describe("Work order page: links, viewers and kills", () => {
  it("shows the Journey as one card, without the written record below it", async () => {
    await show({}, `#record/${W.id}/journey`);
    expect(document.getElementById("dz-doc")).toBeNull();
    expect(screen.queryByText("Completeness")).toBeNull();
  });

  it("degrades cleanly for a viewer without access to the conversation", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ status: 403, body: { ok: false, msg: "No access." } }) });
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(document.getElementById("dz-head")?.textContent).not.toMatch(/is next/);
  });

  it("keeps the traveler reachable from the page", async () => {
    await show();
    expect(document.getElementById("rec-traveler")).toBeTruthy();
  });
});

describe("Changes page", () => {
  it("shows counts, the plan and a way back to the work order", async () => {
    mockApi({ ...readsFor(W) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    expect(await screen.findByRole("heading", { name: "Changes" }, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("chg")).toBeTruthy();
    fireEvent.click(document.getElementById("chg-back") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`record/${W.id}`));
  });

  const H = "a".repeat(64);
  const CALL = { requestId: "r1", run: "run-1", wo: W.id, project: "payments", surface: "run", station: "build", turn: null, model: "claude-test-1", inputTokens: 1200, outputTokens: 300, costMicros: 15000, promptHash: "b".repeat(64), trace: H, outcome: "ok", at: new Date().toISOString() };
  const TRACE = { v: 1, kind: "service-call", manifest: { hash: "b".repeat(64), parts: [
    { kind: "repo_context", name: "Repository context", source: "runs.data.repoContext", version: null, sha256: "c".repeat(64), bytes: 512 },
    { kind: "layer", name: "Agent", source: "instructions", version: 2, sha256: "d".repeat(64), bytes: 80 },
    { kind: "skill", name: "Code review", source: "skill_versions sk-review", version: 3, sha256: "e".repeat(64), bytes: 40 },
  ] }, request: { system: "You are the build agent." }, response: { content: [{ type: "text", text: "Built it." }] } };

  it("reaches a work order's prompt records by clicking the Prompts tab and then a call", async () => {
    const calls = await show({
      "GET /api/v1/prompt-calls": () => ({ body: { ok: true, calls: [CALL] } }),
      [`GET /api/v1/prompt-traces/${H}`]: () => ({ body: { ok: true, trace: TRACE } }),
    }, `#record/${W.id}`);
    fireEvent.click(screen.getByRole("tab", { name: "Prompts" }));
    expect(await screen.findByRole("heading", { name: "Prompts" })).toBeTruthy();
    const row = await waitFor(() => { const r = document.getElementById(`dz-prompt-${H.slice(0, 12)}`); if (!r) throw new Error("no row"); return r; });
    expect(row.textContent).toContain("claude-test-1");
    expect(row.textContent).toContain("$0.0150");
    expect(calls.some((c) => c.path === "/api/v1/prompt-calls" && c.query.get("wo") === W.id)).toBe(true);
    fireEvent.click(row.querySelector("button")!);
    const detail = await waitFor(() => { const d = document.getElementById("dz-prompt-detail"); if (!d) throw new Error("no detail"); return d; });
    for (const t of ["Repository context", "Agent layer", "Skill", "Code review", "skill_versions sk-review"]) expect(detail.textContent).toContain(t);
    expect(document.getElementById("dz-prompt-system")?.textContent).toBe("You are the build agent.");
    expect(document.getElementById("dz-prompt-answer")?.textContent).toContain("Built it.");
    expect(window.location.href).toContain(`call=${H}`);
  });

  it("says the prompt records are not visible when the server refuses them, and says so when there are none", async () => {
    await show({ "GET /api/v1/prompt-calls": () => ({ status: 403, body: { ok: false, msg: "No." } }) }, `#record/${W.id}/prompts`);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    cleanup();
    resetApp();
    await show({ "GET /api/v1/prompt-calls": () => ({ body: { ok: true, calls: [] } }) }, `#record/${W.id}/prompts`);
    expect(await screen.findByText("No model calls are recorded for this work order yet.")).toBeTruthy();
  });
});
