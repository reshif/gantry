import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const traveler = (allowed: boolean) => ({ id: "WO-2398", project: "payments", allowed: { approve: { gate: "G2", instance: "WO-2398:G2:3", allowed, reason: allowed ? "" : "You wrote this work order; someone else must approve.", needs: "" } } });

describe("Inbox", () => {
  it("lists what waits for the person once, grouped by kind, longest wait first", async () => {
    mockApi({ "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE, ONB], conversations: [CONV] }, attention: [] }) }) });
    mount(<InboxView />);
    expect(await screen.findByText("Approve spec · G2")).toBeTruthy();
    expect(document.getElementById("inbox-count")?.textContent).toBe("3");
    expect(screen.getByText("Merge onboarding pull request search-service#3")).toBeTruthy();
    // a tab shows one kind
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    await waitFor(() => expect(screen.queryByText("Approve spec · G2")).toBeNull());
    expect(await screen.findByText("Which currency?")).toBeTruthy();
  });

  it("lists the brief gate under Gate approvals with a pending title, not under Questions with the classifier line", async () => {
    const BRIEF_CONV = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "Classified as Docs (confidence 86%)", gate: { id: "G0G1", label: "G0+G1", name: "Brief confirmed" } };
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [BRIEF_CONV, CONV] }, attention: [] }) }),
      "GET /api/v1/work-orders/WO-1005": () => ({ body: { id: "WO-1005", project: "payments", version: 1, allowed: { approve: { gate: "G0G1", allowed: true, reason: "", needs: "" } } } }),
    });
    mount(<InboxView />);
    expect(await screen.findByText("Confirm brief · G0+G1")).toBeTruthy();
    expect(screen.queryByText(/Classified as Docs/)).toBeNull();
    expect(document.getElementById("inb-gate-WO-1005-G0G1")?.textContent).toContain("WO-1005");
    fireEvent.click(screen.getByRole("tab", { name: /Questions/ }));
    await waitFor(() => expect(document.getElementById("inb-q-WO-2407")?.textContent).toContain("Question"));
    expect(document.getElementById("inb-q-WO-1007")).toBeNull();
  });

  it("lists a stopped work order with its reason and a Retry the server's decision allows", async () => {
    const STUCK = { wo: "WO-1005", title: "Fix the docs", project: "payments", question: "The run could not be started: workspace seeding failed", stuck: { state: "failed", station: "spec", reason: "workspace seeding failed", actions: ["retry", "assign"] } };
    const cs = mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [], conversations: [STUCK] }, attention: [] }) }),
      "GET /api/v1/work-orders/WO-1005": () => ({ body: { id: "WO-1005", project: "payments", version: 4, allowed: { approve: null, can: { sendback: { allowed: true, reason: "" } } } } }),
      "POST /api/v1/work-orders/WO-1005/retry": () => ({ body: { ok: true, msg: "WO-1005 is running again." } }),
    });
    mount(<InboxView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Blocked/ }));
    expect(await screen.findByText(/workspace seeding failed/)).toBeTruthy();
    expect(document.getElementById("inb-stuck-WO-1005")?.textContent).toContain("Needs a person");
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(retry);
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-1005/retry")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/retry"))!.headers["if-match"]).toBe("4");
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
      "POST /api/v1/gate-instances/WO-2398%3AG2%3A3/approve": () => ({ body: { ok: true, msg: "Approved." } }),
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
    const ok = await screen.findByRole("button", { name: "Confirm brief" });
    await waitFor(() => expect(ok.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(ok);
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/confirm-brief")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/confirm-brief"))!.headers["if-match"]).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "Out of scope" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(cs.some((c) => c.path === "/api/v1/work-orders/WO-2400/decline")).toBe(true));
    expect(cs.find((c) => c.path.endsWith("/decline"))!.body).toMatchObject({ reason: "Out of scope" });
    expect(cs.some((c) => c.path.startsWith("/api/v1/gate-instances/"))).toBe(false);
  });

  it("keeps the decision buttons locked with a reason until the server has said what this person may do", async () => {
    mockApi({
      "GET /api/v1/home": () => ({ body: home({ waiting: { approvals: [GATE], conversations: [] } }) }),
      "GET /api/v1/work-orders/WO-2398": () => ({ body: traveler(true) }),
    });
    mount(<InboxView />);
    const ok = await screen.findByRole("button", { name: "Approve" });
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
    expect(await screen.findByText("Nothing is waiting on you")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    mockApi({ "GET /api/v1/home": () => ({ status: 403, body: { ok: false, msg: "Needs a role." } }) });
    mount(<InboxView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });
});
