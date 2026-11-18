import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InboxView from "./inbox";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => { window.history.replaceState(null, "", "/"); resetApp(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GATE = { wo: "WO-2398", title: "Add idempotency keys", gate: "G2", gateLabel: "G2", gateName: "Spec approved", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 3 * 3_600_000 };
const ONB = { repo: "r1", repoName: "search-service", pr: 3, project: "payments", projectName: "Payments Platform" };
const CONV = { wo: "WO-2407", title: "Support partial refunds", project: "payments", question: "Which currency?" };
const home = (sections: Record<string, unknown>) => ({ approvals: [], conversations: [], badges: {}, sections });
const traveler = (allowed: boolean) => ({ id: "WO-2398", project: "payments", allowed: { approve: { gate: "G2", instance: "WO-2398:G2:3", allowed, reason: allowed ? "" : "You wrote this work order; someone else must approve.", needs: "" } } });

describe("Inbox", () => {
  it("lists what waits for the person once, grouped by kind, longest wait first", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, ONB], conversations: [CONV] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Approve spec")).toBeTruthy();
    expect(document.getElementById("inbox-count")?.textContent).toBe("3");
    expect(screen.getByText("Merge onboarding pull request search-service#3")).toBeTruthy();
    // a tab shows one kind
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    await waitFor(() => expect(screen.queryByText("Approve spec")).toBeNull());
    // a question row: the work order links to its record, an Awaiting answer chip, Answer opens the thread
    expect(await screen.findByText("Awaiting answer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Answer" })).toBeTruthy();
    expect(screen.getByText("WO-2407").getAttribute("href")).toContain("record/WO-2407");
  });

  it("lists the brief gate under Gate approvals with a pending title, not under Questions with the classifier line", async () => {
    const BRIEF_CONV = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "Classified as Docs (confidence 86%)", gate: { id: "G0G1", label: "G0+G1", name: "Brief confirmed" } };
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [BRIEF_CONV, CONV] }, attention: [] }) }),
      "GET /api/v1/work-orders/WO-1005": () => ({ body: { id: "WO-1005", project: "payments", version: 1, allowed: { approve: { gate: "G0G1", allowed: true, reason: "", needs: "" } } } }),
    });
    mount(<InboxView />);
    expect(await screen.findByText("Confirm brief")).toBeTruthy();
    expect(screen.queryByText(/Classified as Docs/)).toBeNull();
    expect(document.getElementById("inb-gate-WO-1005-G0G1")?.textContent).toContain("WO-1005");
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    await waitFor(() => expect(document.getElementById("inb-q-WO-2407")?.textContent).toContain("Awaiting answer"));
    expect(document.getElementById("inb-q-WO-1007")).toBeNull();
  });

  it("lists a stopped work order with its reason and Open only (the prototype's row has no Retry)", async () => {
    const STUCK = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "The run could not be started: workspace seeding failed", stuck: { state: "failed", station: "spec", reason: "workspace seeding failed", actions: ["retry", "assign"] } };
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [STUCK] }, attention: [] }) }) });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Blocked/ }));
    expect(await screen.findByText(/workspace seeding failed/)).toBeTruthy();
    expect(document.getElementById("inb-stuck-WO-1005")?.textContent).toContain("WO-1005");
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("approval rows have Approve and Reject only: no Rule button", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    await screen.findByRole("button", { name: /^Approve WO-2398/ });
    expect(screen.queryByRole("button", { name: /Who can approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rule" })).toBeNull();
  });

  it("approves from the row, and locks Approve with the server's reason when this person may not", async () => {
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "POST /api/v1/gate-instances/WO-2398%3AG2%3A3/approve": () => ({ body: { ok: true, msg: "Approved." } }),
    });
    mount(<InboxView />);
    const ok = await screen.findByRole("button", { name: /^Approve WO-2398/ });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    // the prototype's dialog first; the decision is sent when it is confirmed
    expect(await screen.findByText("Approve spec · G2 for WO-2398")).toBeTruthy();
    expect(cs.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(within(document.querySelector<HTMLElement>(".dlg")!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(cs.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/gate-instances/"))).toBe(true));
    cleanup();
    vi.unstubAllGlobals();
    resetApp();
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(false) }),
    });
    mount(<InboxView />);
    const locked = await screen.findByRole("button", { name: /^Approve WO-2398/ });
    await waitFor(() => expect(locked.getAttribute("aria-disabled")).toBe("true"));
    expect(locked.getAttribute("data-reason")).toMatch(/someone else must approve/);
  });

  it("confirms the brief and declines through the brief's own commands, with the version, and never sends a gate approve or reject", async () => {
    const BRIEF = { ...GATE, wo: "WO-2400", gate: "G0G1", gateLabel: "G0/G1", gateName: "Brief confirmed" };
    const tv = { id: "WO-2400", project: "payments", version: 7, allowed: { approve: { gate: "G0G1", allowed: true, reason: "", needs: "" }, can: { decline: { allowed: true, reason: "" } } } };
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [BRIEF], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2400": () => ({ body: tv }),
      "POST /api/v1/work-orders/WO-2400/confirm-brief": () => ({ body: { ok: true, msg: "Brief confirmed." } }),
      "POST /api/v1/work-orders/WO-2400/decline": () => ({ body: { ok: true, msg: "Declined." } }),
    });
    mount(<InboxView />);
    const ok = await screen.findByRole("button", { name: /^Approve WO-2400/ });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    fireEvent.click(within(await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; })).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/confirm-brief")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/confirm-brief"))!.headers["if-match"]).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: /^Reject WO-2400/ }));
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Out of scope for this quarter" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/decline")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/decline"))!.body).toMatchObject({ reason: "Out of scope for this quarter" });
    expect(cs.some((c) => c.path.startsWith("/api/v1/gate-instances/"))).toBe(false);
  });

  it("keeps the decision buttons locked with a reason until the server has said what this person may do", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    const ok = await screen.findByRole("button", { name: /^Approve WO-2398/ });
    expect(ok.getAttribute("aria-disabled")).toBe("true");
    expect(ok.getAttribute("data-reason")).toMatch(/Checking/);
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("names a question's project, and lists one project under one label", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, { ...GATE, wo: "WO-1", project: "ops", projectName: "Ops" }], conversations: [CONV] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    await screen.findByRole("tab", { name: /Approvals/ });
    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>("#inb-proj option")).map((o) => o.textContent);

    expect(opts).not.toContain("payments");
    expect(opts.filter((o) => o === "Payments Platform")).toHaveLength(1);
    expect(screen.queryByText(/listed once/)).toBeNull();
  });

  it("says nothing is waiting, and does not say it on a refused read", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("No approvals waiting")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    mockApi({ "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role." } }) });
    mount(<InboxView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });

  it("Questions and Blocked lists have no search or project filter (the prototype filters Approvals only)", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [CONV, { ...CONV, wo: "WO-2417", stuck: { state: "blocked", station: "build", reason: "x", actions: [] } }] }, attention: [] }) }) });
    mount(<InboxView />);
    await screen.findByText("Approve spec");
    expect(document.getElementById("inbox-search")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    await screen.findByText("Awaiting answer");
    expect(document.getElementById("inbox-search")).toBeNull();
    expect(document.getElementById("inb-proj")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Blocked/ }));
    await screen.findByText("WO-2417");
    expect(document.getElementById("inbox-search")).toBeNull();
  });

  it("the filtered-empty approvals state says to loosen the search and offers Clear filters", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    await screen.findByText("Approve spec");
    fireEvent.change(document.getElementById("inbox-search") as HTMLInputElement, { target: { value: "zzzz" } });
    expect(await screen.findByText("Loosen the search or clear the filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Approve spec")).toBeTruthy();
  });

  it("Open Trust goes to Trust with ?tab=proposals", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] }, attention: [] }) }), "GET /api/v1/trust/cells": () => ({ body: { cells: [], proposals: [{ id: "tp1", cell: "ag-spec|feature|payments", from: 1, to: 2, status: "pending", evidence: { note: "ok" } }], policy: {} } }) });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Proposals/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Trust" }));
    expect(window.location.search).toContain("tab=proposals");
    expect(window.location.hash).toContain("trust");
  });
});

describe("Request changes at a gate (Inbox)", () => {
  it("asks for changes with a reason, pinned to the gate instance and the work order version", async () => {
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: { ...traveler(true), version: 5 } }),
      "POST /api/v1/gate-instances/WO-2398%3AG2%3A3/reject": () => ({ body: { ok: true, msg: "Sent back." } }),
    });
    mount(<InboxView />);
    const btn = await screen.findByRole("button", { name: /^Request changes on WO-2398/ });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(btn);
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Cover the retry path too" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/gate-instances/WO-2398%3AG2%3A3/reject")).toBe(true));
    const call = cs.find((c) => c.path.endsWith("/reject"))!;
    expect(call.body).toMatchObject({ reason: "Cover the retry path too" });
    expect(call.headers["if-match"]).toBe("5");
    expect(await screen.findByText("Changes requested on WO-2398 at G2")).toBeTruthy();
  });
});
