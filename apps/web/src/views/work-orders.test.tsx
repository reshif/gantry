import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../lib/commands";
import { updatePrefs } from "../lib/prefs";
import WorkOrdersView from "./work-orders";
import { useRegisterNewWorkOrder } from "./work-orders/New";
import { PAYMENTS, WOS, REPOS, mockApi, mount, resetApp, type Call } from "./floor/testkit";

beforeEach(() => {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (items: unknown[], next: string | null = null, total = items.length) => ({ items, next, total });
const lists = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/projects/payments/work-orders");
const wo = WOS.find((w) => w.id === "WO-2398");

/** A host that registers the command the way the shell does, so the palette-less New work order button works. */
function Host() {
  useRegisterNewWorkOrder();
  return <WorkOrdersView />;
}

describe("Work orders table", () => {
  it("says the work orders are not visible on a 403, and the header counts don't read as 0", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("Nothing matches these filters")).toBeNull();
    // the tabs carry no count at all while the read is refused, never a 0
    expect(document.querySelectorAll("#wo-tab-all .tab-count, #wo-tab-shipped .tab-count")).toHaveLength(0);
  });

  it("sends the filters, keeps tab, filters, sort and page in the URL, and pages 15 at a time with Prev / Next", async () => {
    const many = Array.from({ length: 17 }, (_, k) => ({ ...WOS[0]!, id: `WO-${5000 + k}`, createdAt: 1000 + k }));
    const calls = mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 17) : page(many, null, 17) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-5016")).toBeTruthy();
    expect(document.querySelectorAll("#wo-table tbody tr")).toHaveLength(15);
    expect(screen.getByText("1–15 of 17")).toBeTruthy();
    expect(screen.getByText("Page 1 / 2")).toBeTruthy();
    // default order is created, newest first
    expect(document.querySelector("#wo-table tbody tr a.pri")?.textContent).toBe("WO-5016");
    fireEvent.click(document.getElementById("wo-table-next") as HTMLElement);
    expect(await screen.findByText("16–17 of 17")).toBeTruthy();
    expect(window.location.search).toContain("page=2");
    fireEvent.click(document.getElementById("wo-table-sort-id") as HTMLElement);
    await waitFor(() => expect(window.location.search).toContain("sort=id"));
    expect(window.location.search).not.toContain("page=");
    fireEvent.change(document.getElementById("wo-f-cls") as HTMLElement, { target: { value: "bug" } });
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("cls") === "bug")).toBe(true));
    expect(window.location.search).toContain("cls=bug");
  });

  it("opens the record from the id link and from the row, and the conversation from its own icon", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 3) : page(WOS.slice(0, 3), null, 3) }) });
    mount(<WorkOrdersView />);
    const link = await screen.findByRole("link", { name: "WO-2398" });
    expect(link.getAttribute("href")).toBe("#/p/payments/record/WO-2398");
    fireEvent.click(document.getElementById("wo-conv-WO-2398") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/conversations/WO-2398"));
  });

  it("the List / Board switch is in the URL and the board is a panel of station columns with cards linking to the record", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 5) : page(WOS.slice(0, 5), null, 5) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-2398");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Board"));
    await waitFor(() => expect(window.location.search).toContain("view=board"));
    expect(await screen.findByRole("heading", { name: "Board" })).toBeTruthy();
    expect(document.querySelectorAll(".board .col").length).toBeGreaterThan(3);
    expect(document.querySelector('.board a.card[href^="#/p/payments/record/"]')).toBeTruthy();
  });

  it("reads every page for the tabs it works out itself, and says when the list is cut short", async () => {
    const base = WOS[0]!;
    const many = (n: number, from: number) => Array.from({ length: n }, (_, k) => ({ ...base, id: `WO-${from + k}`, requestedBy: "p-asha" }));
    let served = 0;
    const calls = mockApi({
      "GET /api/v1/projects/payments/work-orders": (c) => {
        if (c.query.get("limit") === "1") return { body: page([], null, 9000) };
        served += 1;
        return { body: page(many(200, served * 1000), `c${served}`, 9000) };
      },
    });
    mount(<WorkOrdersView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Incidents/ }));
    await waitFor(() => expect(document.querySelector("#wo-tab-incidents .tab-count")?.textContent).toMatch(/\+$/));
    await waitFor(() => expect(document.body.textContent).toMatch(/Only the latest 1000 work orders/), { timeout: 5000 });
    expect(lists(calls).filter((c) => c.query.get("cursor")).length).toBeGreaterThan(3);
  }, 20_000);

  it("filters by assignee, groups the rows and keeps a saved view", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 5) : page(WOS.slice(0, 5), null, 5) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-2398")).toBeTruthy();
    const sel = document.getElementById("wo-f-assignee") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toContain("none");
    fireEvent.change(document.getElementById("wo-group") as HTMLElement, { target: { value: "repo" } });
    await waitFor(() => expect(document.querySelectorAll(".wo-group").length).toBeGreaterThan(0));
    fireEvent.click(document.getElementById("wo-col-by") as HTMLElement);
    expect(document.querySelectorAll("#wo-table-0 thead th").length).toBeGreaterThan(0);
    fireEvent.click(document.getElementById("wo-view-save") as HTMLElement);
    const dlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    fireEvent.change(dlg.querySelector("input,textarea") as HTMLElement, { target: { value: "By repo" } });
    fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "Save view") as HTMLElement);
    await waitFor(() => expect(document.getElementById("wo-views")).toBeTruthy());
    expect(Array.from((document.getElementById("wo-views") as HTMLSelectElement).options).map((o) => o.textContent)).toContain("By repo");
  });

  it("words the Gate column as what the gate needs, never as the outcome it waits for", async () => {
    const failed = { ...wo, id: "WO-3100", state: "failed", station: 2, failReason: "workspace seeding failed", gates: {} } as unknown as typeof WOS[number];
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([failed]) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-3100")).toBeTruthy();
    fireEvent.click(document.getElementById("wo-col-gate") as HTMLElement);
    const cell = Array.from(document.querySelectorAll("#wo-table tbody tr td")).map((td) => td.textContent ?? "");
    expect(cell.some((t) => /^Next: (Approve|Confirm|Review|Check|Wait)/.test(t)), cell.join(" | ")).toBe(true);
    expect(cell.some((t) => t === "Spec approved")).toBe(false);
  });

  it("explains an empty result and clears the filters", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([], null, 0) }) });
    mount(<WorkOrdersView />);
    fireEvent.change(await screen.findByLabelText("Priority"), { target: { value: "P0" } });
    expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("all"));
  });
});

describe("New work order", () => {
  const submitOk = (_c: Call) => ({ body: { ok: true, msg: "WO-3000 submitted.", id: "WO-3000", wo: "WO-3000", classification: wo?.cls } });
  const traveler = () => ({ body: { ...wo, id: "WO-3000", title: "Fix refund crash", clsConfidence: 0.91, clsRationale: "The request describes broken behaviour.", clsSuggested: "bug", cls: "bug", requestedCls: null, conv: { questions: [1, 2, 3], misses: [], messages: [], raised: [], done: false }, version: 1 } });

  async function open(extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}, o: Parameters<typeof mockApi>[1] = {}) {
    const calls = mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([]) }), "GET /api/v1/work-orders/WO-3000": traveler, ...extra }, o);
    mount(<Host />);
    await screen.findByRole("button", { name: /Submit work order/ });
    // the same command the palette runs; the page button itself is locked when submitting is blocked
    act(() => void runCommand("newWorkOrder"));
    await screen.findByLabelText("Title");
    return calls;
  }

  it("submits once with an Idempotency-Key even when the button is clicked twice, then shows the classification and route", async () => {
    const calls = await open({ "POST /api/v1/projects/payments/work-orders": submitOk });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix refund crash" } });
    fireEvent.change(screen.getByLabelText("What should change and why"), { target: { value: "Refund crashes on a zero amount. Steps to reproduce: post zero." } });
    expect(await screen.findByText("Classifier preview:")).toBeTruthy();
    const submit = document.getElementById("nwo-submit") as HTMLElement;
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders") as Call;
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({ repo: "payments-api", title: "Fix refund crash", source: "web" });
    // the card the legacy app showed after a submit: class, confidence and the proposed route
    expect(await screen.findByText("WO-3000 classified as Bug")).toBeTruthy();
    expect(screen.getByText("Proposed route")).toBeTruthy();
    expect(document.querySelector(".int-route")).toBeTruthy();
    expect(screen.getByText(/91%/)).toBeTruthy();
  });

  it("shows the server's refusal inline and keeps the dialog open", async () => {
    await open({ "POST /api/v1/projects/payments/work-orders": () => ({ status: 409, body: { ok: false, msg: "Payments Platform is halted (andon): duplicate refunds." } }) });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix refund crash" } });
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText(/is halted \(andon\)/)).toBeTruthy();
    expect(screen.getByLabelText("Title")).toBeTruthy();
  });

  it("clears the inline title error as soon as a title is typed", async () => {
    await open();
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText("Give the work order a title.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix refund crash" } });
    await waitFor(() => expect(screen.queryByText("Give the work order a title.")).toBeNull());
  });

  it("locks the submit button with the reason while the factory is killed, and sends nothing", async () => {
    const calls = await open({}, { me: { factory: { killed: { by: "p-asha", at: 1, reason: "Runaway spend", mode: "hold", restoreApprovals: [] } } } });
    const submit = document.getElementById("nwo-submit") as HTMLElement;
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.getAttribute("data-reason")).toMatch(/The factory is killed: Runaway spend/);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix refund crash" } });
    fireEvent.click(submit);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders")).toBe(false);
  });

  it("points to onboarding when no repo is ready", async () => {
    const notReady = REPOS.map((r) => ({ ...r, onboarding: { ...r.onboarding, stage: "assessed", exception: null } }));
    await open({ "GET /api/v1/projects/payments/repos": () => ({ body: notReady }) });
    await waitFor(() => expect(screen.getByText(/is not ready: onboarding is at 'Assessed'/)).toBeTruthy());
    expect(document.getElementById("nwo-onb-link")).toBeTruthy();
    expect(document.getElementById("nwo-submit")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("locks the page button with the reason when this person may not submit", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([]) }) }, { denied: ["wo.submit"] });
    mount(<WorkOrdersView />);
    const btn = await screen.findByRole("button", { name: /Submit work order/ });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(btn.getAttribute("data-reason")).toMatch(/No role holds it/);
    fireEvent.click(btn);
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("refuses for a person who may not submit, with their reason", async () => {
    await open({}, { denied: ["wo.submit"] });
    await waitFor(() => expect(document.getElementById("nwo-submit")?.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("nwo-submit")?.getAttribute("data-reason")).toMatch(/No role holds it/);
    void PAYMENTS;
  });
});
