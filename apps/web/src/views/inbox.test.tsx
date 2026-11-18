import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InboxView from "./inbox";
import { clearDecided } from "../lib/decided";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => { resetApp(); clearDecided(); window.history.replaceState(null, "", "/"); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GATE = { wo: "WO-2398", title: "Add idempotency keys", gate: "G2", gateLabel: "G2", gateName: "Spec approved", project: "payments", projectName: "Payments Platform", have: 1, need: 2, waitMs: 3 * 3_600_000 };
const ONB = { repo: "r1", repoName: "search-service", pr: 3, project: "payments", projectName: "Payments Platform" };
const CONV = { wo: "WO-2407", title: "Support partial refunds", project: "payments", question: "Which currency?" };
const home = (sections: Record<string, unknown>) => ({ approvals: [], conversations: [], badges: {}, sections });
const approvers = {
  label: "Spec approved",
  rule: { text: "Two approvers from Reviewer or Approver, not the requester.", conditions: [] },
  progress: { have: 1, need: 2, approvals: [{ name: "Meera Iyer" }], unmet: [] },
  satisfiable: true,
  warning: "",
  eligible: [{ id: "p1", name: "Grace Liu", why: "Approver" }],
  overrides: [],
  viewerCanOverride: false,
  can: { editRule: true, editWhy: "", grantRole: true, grantWhy: "" },
};
const traveler = (allowed: boolean) => ({ id: "WO-2398", project: "payments", allowed: { approve: { gate: "G2", instance: "WO-2398:G2:3", allowed, reason: allowed ? "" : "You wrote this work order; someone else must approve.", needs: "" } } });

/** The row's one Review button opens the decision. */
const review = async (nth = 0) => { const b = await screen.findAllByRole("button", { name: "Review" }); fireEvent.click(b[nth]!); };

describe("Inbox", () => {
  it("lists approvals in one table and questions on their own tab", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, ONB], conversations: [CONV] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Approve spec · G2 for WO-2398")).toBeTruthy();
    expect(document.getElementById("inbox-count")?.textContent).toBe("3");
    expect(screen.getByText("Merge onboarding pull request search-service#3")).toBeTruthy();
    expect(screen.queryByText("Which currency?")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    expect(screen.queryByText("Approve spec · G2 for WO-2398")).toBeNull();
    expect(screen.getByText("Which currency?")).toBeTruthy();
  });

  it("lists the brief gate under Gate approvals with a pending title, not under Questions with the classifier line", async () => {
    const BRIEF_CONV = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "Classified as Docs (confidence 86%)", gate: { id: "G0G1", label: "G0+G1", name: "Brief confirmed" } };
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [BRIEF_CONV, CONV] }, attention: [] }) }),
      "GET /api/v1/work-orders/WO-1005": () => ({ body: { id: "WO-1005", project: "payments", version: 1, allowed: { approve: { gate: "G0G1", allowed: true, reason: "", needs: "" } } } }),
    });
    mount(<InboxView />);
    expect(await screen.findByText("Confirm brief · G0+G1 for WO-1005")).toBeTruthy();
    expect(screen.queryByText(/Classified as Docs/)).toBeNull();
    expect(document.getElementById("inb-gate-WO-1005-G0G1")?.textContent).toContain("Gate");
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    expect(document.getElementById("inb-q-WO-2407")?.textContent).toContain("Which currency?");
  });

  it("lists a stopped work order with its reason and a Retry the server's decision allows", async () => {
    const STUCK = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "The run could not be started: workspace seeding failed", stuck: { state: "failed", station: "spec", reason: "workspace seeding failed", actions: ["retry", "assign"] } };
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [STUCK] }, attention: [] }) }),
      "GET /api/v1/work-orders/WO-1005": () => ({ body: { id: "WO-1005", project: "payments", version: 4, allowed: { approve: null, can: { sendback: { allowed: true, reason: "" } } } } }),
      "POST /api/v1/work-orders/WO-1005/retry": () => ({ body: { ok: true, msg: "WO-1005 is running again." } }),
    });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Questions/ }));
    expect(await screen.findByText(/workspace seeding failed/)).toBeTruthy();
    expect(document.getElementById("inb-stuck-WO-1005")?.textContent).toContain("Failed");
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(retry);
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-1005/retry")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/retry"))!.headers["if-match"]).toBe("4");
  });

  it("shows the rule and who else can decide in the Review dialog, read from the server", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "GET /api/v1/work-orders/WO-2398/gates/G2/approvers": () => ({ body: approvers }),
    });
    mount(<InboxView />);
    await review();
    expect(await screen.findByText(/Two approvers from Reviewer or Approver/)).toBeTruthy();
    expect(screen.getByText("Eligible")).toBeTruthy();
    expect(screen.getByText(/Grace Liu/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByLabelText("Comment")).toBeTruthy();
  });

  it("opens the Review dialog without crashing when the rule read has no progress yet", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "GET /api/v1/work-orders/WO-2398/gates/G2/approvers": () => ({ body: {} }),
    });
    mount(<InboxView />);
    await review();
    expect(await screen.findByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.queryByText("Gantry hit a problem")).toBeNull();
  });

  it("sorts on the Waiting column (key at) and shows the prototype's neutral arrow on the other sortable headers", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }) });
    mount(<InboxView />);
    await screen.findByText("Add idempotency keys", { exact: false });
    expect(document.getElementById("t-inbox-sort-at")).toBeTruthy();
    expect(document.getElementById("t-inbox-sort-title")?.textContent).toContain("\u2195");
  });

  it("?state=error shows the shared error state under the Inbox header", async () => {
    window.history.replaceState(null, "", "/?state=error");
    mockApi({ "GET /api/v1/home": () => ({ body: home({}) }) });
    mount(<InboxView />);
    expect(await screen.findByText("This view failed to load")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
  });

  it("approves from the row, and locks Approve with the server's reason when this person may not", async () => {
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "POST /api/v1/gate-instances/WO-2398%3AG2%3A3/approve": () => ({ body: { ok: true, msg: "Approved." } }),
    });
    mount(<InboxView />);
    await review();
    const ok = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    await waitFor(() => expect(cs.some((c) => c.method === "POST" && c.path.startsWith("/api/v1/gate-instances/"))).toBe(true));
    cleanup();
    vi.unstubAllGlobals();
    resetApp();
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(false) }),
    });
    mount(<InboxView />);
    await review();
    const locked = await screen.findByRole("button", { name: /^Approve/ });
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
    await review();
    const ok = await screen.findByRole("button", { name: "Confirm brief" });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/confirm-brief")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/confirm-brief"))!.headers["if-match"]).toBe("7");
    await review();
    const dlg = await waitFor(() => { const e = Array.from(document.querySelectorAll<HTMLElement>(".dlg")).pop(); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByLabelText("Comment"), { target: { value: "Out of scope for now" } });
    const rej = within(dlg).getByRole("button", { name: "Reject" });
    await waitFor(() => expect(rej.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(rej);
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/decline")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/decline"))!.body).toMatchObject({ reason: "Rejected: Out of scope for now" });
    expect(cs.some((c) => c.path.startsWith("/api/v1/gate-instances/"))).toBe(false);
  });

  it("keeps the decision buttons locked with a reason until the server has said what this person may do", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    await review();
    const ok = await screen.findByRole("button", { name: "Approve" });
    expect(ok.getAttribute("aria-disabled")).toBe("true");
    expect(ok.getAttribute("data-reason")).toMatch(/Checking/);
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
  });

  it("lists project keys, typed chips, votes, and keeps the tab, search and type in the URL with a Clear", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, ONB], conversations: [CONV] }, attention: [{ id: "t1", sev: 1, icon: "x", title: "Raise trust on Spec", where: "Payments", sub: "proposal", act: { label: "Open Trust", route: "trust" } }] }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    await screen.findByText("Approve spec · G2 for WO-2398");
    const row = document.getElementById("inb-gate-WO-2398-G2")!;
    expect(row.textContent).toContain("1/2");
    expect(row.textContent).toContain("3h ago");
    expect(document.getElementById("inb-t1")?.textContent).toContain("Trust");
    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>("#inbox-type option")).map((o) => o.textContent);
    expect(opts).toEqual(["Type: all", "Gate", "Trust", "Learning", "MCP", "Trigger", "Onboarding"]);
    expect(document.getElementById("inb-proj")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    fireEvent.change(document.getElementById("inbox-type")!, { target: { value: "trust" } });
    await waitFor(() => expect(window.location.search).toContain("type=trust"));
    expect(screen.queryByText("Approve spec · G2 for WO-2398")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await screen.findByText("Approve spec · G2 for WO-2398");
    expect(window.location.search).not.toContain("type=");
    fireEvent.click(screen.getByRole("tab", { name: /Decided/ }));
    await waitFor(() => expect(window.location.search).toContain("tab=decided"));
    expect(await screen.findByText("No decisions yet this session")).toBeTruthy();
  });

  it("lists an approval under Decided after it is approved here", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "POST /api/v1/gate-instances/WO-2398%3AG2%3A3/approve": () => ({ body: { ok: true, msg: "Approved." } }),
    });
    mount(<InboxView />);
    await review();
    const ok = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    fireEvent.click(await screen.findByRole("tab", { name: /Decided/ }));
    expect(await screen.findByText("Approve spec · G2 for WO-2398")).toBeTruthy();
    expect(screen.getAllByText(/Approved/).length).toBeGreaterThan(0);
  });

  it("answers a question in place with Write an answer", async () => {
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [CONV] }, attention: [] }) }),
      "POST /api/v1/work-orders/WO-2407/messages": () => ({ body: { ok: true, msg: "Sent." } }),
    });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Questions/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Write an answer…" }));
    const dlg = await waitFor(() => { const e = Array.from(document.querySelectorAll<HTMLElement>(".dlg")).pop(); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Use EUR" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2407/messages")).toBe(true));
  });

  it("shows one button per answer option beside Write an answer, with no Question chip or Open conversation, and sends the option", async () => {
    const asked = { ...CONV, options: ["EUR", "USD"], agent: "ag-spec" };
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [asked] }, attention: [] }) }),
      "POST /api/v1/work-orders/WO-2407/messages": () => ({ body: { ok: true, msg: "Sent." } }),
    });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Questions/ }));
    expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
    expect(document.getElementById("inb-q-WO-2407")?.textContent).toContain("asked about");
    fireEvent.click(await screen.findByRole("button", { name: "EUR" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2407/messages")).toBe(true));
  });

  it("names the wait with one unit, like the prototype (6h ago, not 6h 00m ago)", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [{ ...GATE, waitMs: 6 * 3_600_000 }], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("6h ago")).toBeTruthy();
  });

  it("?state=forbidden names the role and the permission; ?state=error carries an error id", async () => {
    window.history.replaceState(null, "", "/?state=forbidden");
    mockApi({ "GET /api/v1/home": () => ({ body: home({}) }) });
    mount(<InboxView />);
    expect(await screen.findByText(/people\.manage/)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/?state=error");
    mount(<InboxView />);
    expect(await screen.findByText(/Error id: e-/)).toBeTruthy();
  });

  it("says nothing is waiting, and does not say it on a refused read", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Inbox zero")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    mockApi({ "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role." } }) });
    mount(<InboxView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });
});
