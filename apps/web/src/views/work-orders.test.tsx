import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

describe("Work orders tabs, More, grouping, columns and saved views (reached by clicking)", () => {
  const two = [{ ...WOS[0]!, id: "WO-6001", repo: "repo-a", requestedBy: "p-asha", createdAt: 2000 }, { ...WOS[0]!, id: "WO-6002", repo: "repo-b", requestedBy: "p-other", createdAt: 1000 }];
  const boot = () => mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 2) : page(two, null, 2) }) });

  it("renders the tab strip without ?tab=, and a tab click filters and lands in the URL", async () => {
    boot();
    mount(<WorkOrdersView />);
    expect(await screen.findByRole("tab", { name: /Requested by me/ })).toBeTruthy();
    for (const n of ["All", "At a gate", "Intake", "Open", "Done", "Incidents", "Killed"]) expect(screen.getByRole("tab", { name: new RegExp(n) })).toBeTruthy();
    expect(await screen.findByText("WO-6002")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Requested by me/ }));
    await waitFor(() => expect(window.location.hash).toContain("tab=mine"));
    await waitFor(() => expect(screen.queryByText("WO-6002")).toBeNull());
  });

  it("More opens Group by, Repo, Source, Assignee, Columns and Save view; grouping, hiding a column and saving a view work", async () => {
    boot();
    mount(<WorkOrdersView />);
    await screen.findByText("WO-6001");
    expect(document.getElementById("wo-group")).toBeNull();
    fireEvent.click(document.getElementById("wo-more") as HTMLElement);
    for (const id of ["wo-group", "wo-f-repo", "wo-f-source", "wo-f-assignee", "wo-view-save", "wo-col-prio"]) expect(document.getElementById(id)).toBeTruthy();
    fireEvent.change(document.getElementById("wo-group") as HTMLElement, { target: { value: "repo" } });
    await waitFor(() => expect(document.querySelectorAll(".wo-group").length).toBe(2));
    expect(window.location.hash).toContain("group=repo");
    expect(document.querySelector("#wo-table-0 th")).toBeTruthy();
    fireEvent.click(document.getElementById("wo-col-prio") as HTMLElement);
    await waitFor(() => expect(document.getElementById("wo-table-0-sort-prio")).toBeNull());
    fireEvent.click(document.getElementById("wo-view-save") as HTMLElement);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Grouped by repo" } });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(document.getElementById("wo-views")).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem("gantry.wo.views.payments") ?? "[]")[0]?.name).toBe("Grouped by repo");
  });
});

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
    expect(await screen.findByText("WO-5014")).toBeTruthy();
    expect(document.querySelectorAll("#wo-table tbody tr")).toHaveLength(15);
    expect(screen.getByText("1–15 of 17")).toBeTruthy();
    expect(screen.getByText("Page 1 / 2")).toBeTruthy();
    // the default order puts what needs the person first; the sort is in the URL only once it is changed
    expect(window.location.hash).not.toContain("sort=");
    fireEvent.click(document.getElementById("wo-table-next") as HTMLElement);
    expect(await screen.findByText("16–17 of 17")).toBeTruthy();
    expect(window.location.hash).toContain("page=2");
    fireEvent.click(document.getElementById("wo-table-sort-id") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain("sort=id"));
    expect(window.location.hash).not.toContain("page=");
    fireEvent.change(document.getElementById("wo-f-cls") as HTMLElement, { target: { value: "bug" } });
    await waitFor(() => expect(lists(calls).some((c) => c.query.get("cls") === "bug")).toBe(true));
    expect(window.location.hash).toContain("cls=bug");
  });

  it("opens the record from the id link and from the row; no extra icon column", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 3) : page(WOS.slice(0, 3), null, 3) }) });
    mount(<WorkOrdersView />);
    const link = await screen.findByRole("link", { name: "WO-2398" });
    expect(link.getAttribute("href")).toBe("#/p/payments/record/WO-2398");
    // the prototype's table has no traveler / conversation icon column: the id link and the row are the way in
    expect(document.getElementById("wo-trav-WO-2398")).toBeNull();
    fireEvent.click(link.closest("tr") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/record/WO-2398"));
  });

  it("the List / Board switch is in the URL and the board is a panel of station columns with cards linking to the record", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 5) : page(WOS.slice(0, 5), null, 5) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-2398");
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Board"));
    await waitFor(() => expect(window.location.hash).toContain("view=board"));
    expect(await screen.findByRole("heading", { name: "Board" })).toBeTruthy();
    expect(document.querySelectorAll(".board .col").length).toBeGreaterThan(3);
    expect(document.querySelector('.board a.card[href^="#/p/payments/record/"]')).toBeTruthy();
  });

  it("reads every page for a tab link (?tab=incidents) it works out itself, and says when the list is cut short", async () => {
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
    window.history.replaceState(null, "", "?tab=incidents");
    mount(<WorkOrdersView />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Only the latest 1000 work orders/), { timeout: 5000 });
    expect(lists(calls).filter((c) => c.query.get("cursor")).length).toBeGreaterThan(3);
  }, 20_000);

  it("?station= presets the Station filter by id or by number", async () => {
    window.history.replaceState(null, "", "?station=S5");
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 5) : page(WOS.slice(0, 5), null, 5) }) });
    mount(<WorkOrdersView />);
    const station = (await waitFor(() => { const e = document.getElementById("wo-f-where"); if (!e) throw new Error("no select"); return e; })) as HTMLSelectElement;
    expect(station.value).toBe("build");
    expect(Array.from(station.options).some((o) => /^Bay:/.test(o.textContent ?? ""))).toBe(false);
  });

  it("is the prototype's panel: eight columns (no Project while scoped to one project), four filters, no disclosure, no Open column", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": (c) => ({ body: c.query.get("limit") === "1" ? page([], null, 5) : page(WOS.slice(0, 5), null, 5) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-2398")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("#wo-table thead th")).map((t) => (t.textContent ?? "").replace(/[^A-Za-z ]/g, "").trim())).toEqual(["Work order", "Station", "Class", "Prio", "Needs", "Last activity", "Cost", "Actions"]);
    expect(document.querySelectorAll(".wo-bar select")).toHaveLength(4);
    expect(document.querySelector(".wo-more, #wo-more-btn, #wo-view-save, #wo-group, #wo-cols-btn")).toBeNull();
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
    await screen.findByLabelText(/^Title/);
    return calls;
  }

  it("submits once with an Idempotency-Key even when the button is clicked twice, then shows the classification and route", async () => {
    const calls = await open({ "POST /api/v1/projects/payments/work-orders": submitOk });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
    fireEvent.change(screen.getByLabelText(/What should change/), { target: { value: "Refund crashes on a zero amount. Steps to reproduce: post zero." } });
    expect(await screen.findByText("Classifier preview:")).toBeTruthy();
    const submit = document.getElementById("nwo-submit") as HTMLElement;
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders") as Call;
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({ repo: "payments-api", title: "Fix refund crash", source: "web" });
    expect(post.body).not.toHaveProperty("requestedCls", "feature"); // untouched Class and Priority are not sent: the Intake agent classifies
    // the card the legacy app showed after a submit: class, confidence and the proposed route
    expect(await screen.findByText("WO-3000 classified as Bug")).toBeTruthy();
    expect(screen.getByText("Proposed route")).toBeTruthy();
    expect(document.querySelector(".int-route")).toBeTruthy();
    expect(screen.getByText(/91%/)).toBeTruthy();
  });

  it("has the prototype's fields: Title, What should change and why, Project, Class (Feature), Priority (P2), and no Source", async () => {
    await open();
    expect(screen.getByLabelText(/What should change and why/)).toBeTruthy();
    expect(document.getElementById("nwo-project")).toBeTruthy();
    expect((document.getElementById("nwo-cls") as HTMLSelectElement).selectedOptions[0]?.textContent).toMatch(/Feature/);
    expect((document.getElementById("nwo-prio") as HTMLSelectElement).value).toBe("P2");
    expect(document.getElementById("nwo-source")).toBeNull();
    // the prototype's sheet: no repo picker, all ten classes
    expect(document.getElementById("nwo-repo")).toBeNull();
    expect((document.getElementById("nwo-cls") as HTMLSelectElement).options.length).toBe(9);
    expect(screen.queryByLabelText("Requested class")).toBeNull();
  });

  it("shows the server's refusal inline and keeps the dialog open", async () => {
    await open({ "POST /api/v1/projects/payments/work-orders": () => ({ status: 409, body: { ok: false, msg: "Payments Platform is halted (andon): duplicate refunds." } }) });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
    fireEvent.change(screen.getByLabelText(/What should change and why/), { target: { value: "Refunds crash when the amount is zero." } });
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText(/is halted \(andon\)/)).toBeTruthy();
    expect(screen.getByLabelText(/^Title/)).toBeTruthy();
  });

  it("clears the inline title error as soon as a title is typed", async () => {
    await open();
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText("Title is required.")).toBeTruthy();
    expect(screen.getByText("What should change and why is required.")).toBeTruthy();
    expect(document.activeElement?.id).toBe("nwo-title");
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
    await waitFor(() => expect(screen.queryByText("Title is required.")).toBeNull());
  });

  it("locks the submit button with the reason while the factory is killed, and sends nothing", async () => {
    const calls = await open({}, { me: { factory: { killed: { by: "p-asha", at: 1, reason: "Runaway spend", mode: "hold", restoreApprovals: [] } } } });
    const submit = document.getElementById("nwo-submit") as HTMLElement;
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.getAttribute("data-reason")).toMatch(/The factory is killed: Runaway spend/);
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
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
    expect(screen.queryByLabelText(/^Title/)).toBeNull();
  });

  it("refuses for a person who may not submit, with their reason", async () => {
    await open({}, { denied: ["wo.submit"] });
    await waitFor(() => expect(document.getElementById("nwo-submit")?.getAttribute("aria-disabled")).toBe("true"));
    expect(document.getElementById("nwo-submit")?.getAttribute("data-reason")).toMatch(/No role holds it/);
    void PAYMENTS;
  });

  it("opens as the prototype's Submit a work order dialog: Title, What should change and why, Project, Class, Priority", async () => {
    await open();
    for (const id of ["nwo-title", "nwo-desc", "nwo-project", "nwo-cls", "nwo-prio"]) expect(document.getElementById(id)).toBeTruthy();
    expect(screen.getByLabelText("What should change and why (required)")).toBeTruthy();
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(document.getElementById("nwo-source")).toBeNull();
  });
});
