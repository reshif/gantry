import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InboxView from "./inbox";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => resetApp());
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
const traveler = (allowed: boolean) => ({ id: "WO-2398", project: "payments", allowed: { approve: { gate: "G2", allowed, reason: allowed ? "" : "You wrote this work order; someone else must approve.", needs: "" } } });

describe("Inbox", () => {
  it("lists what waits for the person once, grouped by kind, longest wait first", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, ONB], conversations: [CONV] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Spec approved · G2 on WO-2398")).toBeTruthy();
    expect(document.getElementById("inbox-count")?.textContent).toBe("3");
    expect(screen.getByText("Merge onboarding pull request search-service#3")).toBeTruthy();
    expect(screen.getByText("Which currency?")).toBeTruthy();
    // a filter shows one kind
    fireEvent.click(screen.getByLabelText(/Questions 1/));
    expect(screen.queryByText("Spec approved · G2 on WO-2398")).toBeNull();
    expect(screen.getByText("Which currency?")).toBeTruthy();
  });

  it("shows the rule and who else can decide under Show details, read from the server", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "GET /api/v1/work-orders/WO-2398/gates/G2/approvers": () => ({ body: approvers }),
    });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
    expect(await screen.findByText(/Two approvers from Reviewer or Approver/)).toBeTruthy();
    expect(screen.getByText(/Can decide: Grace Liu/)).toBeTruthy();
  });

  it("approves from the row, and locks Approve with the server's reason when this person may not", async () => {
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
      "POST /api/v1/gate-instances/WO-2398%3AG2/approve": () => ({ body: { ok: true, msg: "Approved." } }),
    });
    mount(<InboxView />);
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
    const locked = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(locked.getAttribute("aria-disabled")).toBe("true"));
    expect(locked.getAttribute("data-reason")).toMatch(/someone else must approve/);
  });

  it("says nothing is waiting, and does not say it on a refused read", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Nothing is waiting on you")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    mockApi({ "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role." } }) });
    mount(<InboxView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });
});
