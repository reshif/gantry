import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../lib/commands";
import { updatePrefs } from "../lib/prefs";
import WorkOrdersView from "./work-orders";
import { useRegisterNewWorkOrder } from "./work-orders/New";
import { PAYMENTS, WOS, REPOS, mockApi, mount, resetApp, type Call } from "./floor/testkit";

beforeEach(() => {
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
    expect(screen.queryByText("No work orders match")).toBeNull();
    const shipped = Array.from(document.querySelectorAll(".titleblock div")).find((d) => d.textContent?.startsWith("Shipped"));
    expect(shipped?.querySelector(".async-stat")).toBeTruthy();
  });

  it("asks the server for the sorted, filtered page and pages with the cursor", async () => {
    const first = WOS.slice(0, 3);
    const calls = mockApi({
      "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("cursor") ? page(WOS.slice(3, 5), null, 5) : c.query.get("limit") === "1" ? page([], null, 7) : page(first, "c1", 5) }),
    });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-2398")).toBeTruthy();
    expect(document.querySelectorAll("#wo-table tbody tr")).toHaveLength(3);
    expect(screen.getByText("3 of 5 shown")).toBeTruthy();
    // header sort is server-side: the id column starts descending, a click flips it
    fireEvent.click(document.getElementById("wo-sort-title") as HTMLElement);
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("sort") === "title" && c.query.get("dir") === "asc")).toBe(true));
    // filters are sent, "all" is not
    fireEvent.change(document.getElementById("wo-f-cls") as HTMLElement, { target: { value: "bug" } });
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("cls") === "bug")).toBe(true));
    fireEvent.change(document.getElementById("wo-f-where") as HTMLElement, { target: { value: "spec" } });
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("where") === "spec" && c.query.get("cls") === "bug")).toBe(true));
    fireEvent.click(document.getElementById("wo-table-more") as HTMLElement);
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("cursor") === "c1")).toBe(true));
    expect(await screen.findByText("5 of 5 shown")).toBeTruthy();
  });

  it("explains an empty result and clears the filters", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([], null, 0) }) });
    mount(<WorkOrdersView />);
    fireEvent.change(await screen.findByLabelText("Priority"), { target: { value: "P0" } });
    expect(await screen.findByText("No work orders match")).toBeTruthy();
    fireEvent.click(document.getElementById("wo-clear") as HTMLElement);
    await waitFor(() => expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("all"));
  });
});

describe("New work order", () => {
  const submitOk = (c: Call) => ({ body: { ok: true, msg: "WO-3000 submitted.", id: "WO-3000", wo: "WO-3000", classification: wo?.cls } });
  const traveler = () => ({ body: { ...wo, id: "WO-3000", title: "Fix refund crash", clsConfidence: 0.91, clsRationale: "The request describes broken behaviour.", clsSuggested: "bug", cls: "bug", requestedCls: null, conv: { questions: [1, 2, 3], misses: [], messages: [], raised: [], done: false }, version: 1 } });

  async function open(extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}, o: Parameters<typeof mockApi>[1] = {}) {
    const calls = mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([]) }), "GET /api/v1/work-orders/WO-3000": traveler, ...extra }, o);
    mount(<Host />);
    await screen.findByRole("button", { name: /New work order/ });
    // the same command the palette runs; the page button itself is locked when submitting is blocked
    act(() => void runCommand("newWorkOrder"));
    await screen.findByLabelText("Title");
    return calls;
  }

  it("submits once with an Idempotency-Key even when the button is clicked twice, then shows the classification and route", async () => {
    const calls = await open({ "POST /api/v1/projects/payments/work-orders": submitOk });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fix refund crash" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Refund crashes on a zero amount. Steps to reproduce: post zero." } });
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
    const btn = await screen.findByRole("button", { name: /New work order/ });
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
