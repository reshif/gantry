import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import WorkOrdersView from "./work-orders";
import ConsoleSubmitView from "./console-submit";
import { PAYMENTS, WOS, REPOS, mockApi, mount, resetApp, type Call } from "./floor/testkit";

beforeEach(() => {
  resetApp();
  window.history.replaceState(null, "", "/");
  window.location.hash = "";
  updatePrefs({ scopeAll: false, project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (items: unknown[], next: string | null = null, total = items.length) => ({ items, next, total });
const lists = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/projects/payments/work-orders");
const wo = WOS.find((w) => w.id === "WO-2398");

const qs = () => new URLSearchParams(window.location.search);

describe("Work orders table", () => {
  it("says the work orders are not visible on a 403", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
    expect(screen.queryByText("Nothing matches")).toBeNull();
  });

  it("has the prototype header, the four views and the filter bar in prototype order, with no View options panel, All records or Open column", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(WOS.slice(0, 3)) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-2398")).toBeTruthy();
    expect(Array.from(document.querySelectorAll('[aria-label="Work order views"] .seg-label')).map((l) => l.textContent)).toEqual(["All", "Requested by me", "At a gate", "Blocked"]);
    // the Table / Board switch sits at the right end of the view row, so the board is reachable by clicking
    expect(Array.from(document.querySelectorAll('[aria-label="Table or board"] .seg-label')).map((l) => l.textContent)).toEqual(["Table", "Board"]);
    expect(document.getElementById("wo-opts-btn")).toBeNull();
    expect(document.getElementById("wo-opts")).toBeNull();
    // the filter options are the prototype's, not the server's state names
    const opts = (id: string) => Array.from((document.getElementById(id) as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opts("wo-f-state")).toEqual(["State: all", "Running", "Queued", "Gate", "Blocked", "Done"]);
    expect(opts("wo-f-prio")).toEqual(["Priority: all", "P1", "P2", "P3"]);
    expect(Array.from(document.querySelectorAll(".filterbar select")).map((e) => e.id)).toEqual(["wo-f-state", "wo-f-cls", "wo-f-prio", "wo-f-where"]);
    expect((document.querySelector(".filterbar input") as HTMLInputElement).placeholder).toBe("Search id, title, repo");
    expect(screen.queryByRole("button", { name: /All records/ })).toBeNull();
    expect(document.getElementById("wo-mode-table")).toBeTruthy();
    expect(document.querySelectorAll("#wo-table thead .th-arrow-idle").length).toBeGreaterThan(3);
    expect(Array.from(document.querySelectorAll("#wo-table thead th")).map((t) => t.textContent?.replace(/[↑↓↕]/g, "").trim())).toEqual(["", "ID", "Title", "Class", "Station", "Needs", "Activity", ""]);
  });

  it("puts the view, filters, sort and page in the URL and filters the rows here (the count says shown of all)", async () => {
    const gated = { ...wo, id: "WO-3201", state: "waiting", gates: { G2: { status: "waiting", approvals: [], rejections: [], checks: [] } } };
    const queued = { ...wo, id: "WO-3202", state: "waiting", gates: {} };
    const blocked = { ...wo, id: "WO-3203", state: "blocked", gates: {} };
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([gated, queued, blocked]) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-3201")).toBeTruthy();
    expect(document.querySelector(".filterbar-count")?.textContent).toBe("3 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "At a gate" }));
    await waitFor(() => expect(qs().get("view")).toBe("gate"));
    await waitFor(() => expect(document.querySelector(".filterbar-count")?.textContent).toBe("1 of 3"));
    expect(screen.queryByText("WO-3202")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Blocked" }));
    await waitFor(() => expect(document.querySelector(".filterbar-count")?.textContent).toBe("1 of 3"));
    expect(screen.getByText("WO-3203")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.change(document.getElementById("wo-f-state") as HTMLElement, { target: { value: "queued" } });
    await waitFor(() => expect(qs().get("st")).toBe("queued"));
    await waitFor(() => expect(document.querySelector(".filterbar-count")?.textContent).toBe("1 of 3"));
    expect(screen.getByText("WO-3202")).toBeTruthy();
    fireEvent.change(document.getElementById("wo-f-cls") as HTMLElement, { target: { value: "bug" } });
    await waitFor(() => expect(qs().get("cls")).toBe("bug"));
    fireEvent.change(document.getElementById("wo-f-where") as HTMLElement, { target: { value: "spec" } });
    await waitFor(() => expect(qs().get("station")).toBe("spec"));
    fireEvent.change(document.querySelector(".filterbar input") as HTMLElement, { target: { value: "retry" } });
    await waitFor(() => expect(qs().get("q")).toBe("retry"));
  });

  it("restores the view and filters from a link", async () => {
    window.history.replaceState(null, "", "/?view=blocked&pri=P1");
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(WOS.slice(0, 3)) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("Nothing matches");
    expect((screen.getByRole("radio", { name: "Blocked" }) as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("wo-f-prio") as HTMLSelectElement).value).toBe("P1");
  });

  it("\"Requested by me\" lists only the signed-in person's work orders", async () => {
    const mine = { ...wo, id: "WO-3301", requestedBy: "p-asha" };
    const other = { ...wo, id: "WO-3302", requestedBy: "p-tomas" };
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([mine, other]) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-3301");
    fireEvent.click(screen.getByRole("radio", { name: "Requested by me" }));
    await waitFor(() => expect(screen.queryByText("WO-3302")).toBeNull());
    expect(screen.getByText("WO-3301")).toBeTruthy();
  });

  it("reads every page, so the pager and Export CSV cover all rows, and says when the list is cut short", async () => {
    const base = WOS[0]!;
    const many = (n: number, from: number) => Array.from({ length: n }, (_, k) => ({ ...base, id: `WO-${from + k}`, requestedBy: "p-asha" }));
    let served = 0;
    const calls = mockApi({
      "GET /api/v1/projects/payments/work-orders": () => {
        served += 1;
        return { body: page(many(200, served * 1000), `c${served}`, 9000) };
      },
    });
    mount(<WorkOrdersView />);
    await waitFor(() => expect(document.body.textContent).toMatch(/Only the latest 1000 work orders/), { timeout: 5000 });
    expect(lists(calls).filter((c) => c.query.get("cursor")).length).toBeGreaterThan(3);
    expect(document.querySelector("#wo-table .pager")?.textContent).toMatch(/1–12 of 1000/);
  }, 20_000);

  it("has a Table / Board switch, a faint sort arrow on every sortable column, and no sort select, group by, columns or saved views", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(WOS.slice(0, 3)) }) });
    mount(<WorkOrdersView />);
    expect(await screen.findByText("WO-2398")).toBeTruthy();
    for (const id of ["wo-sort-select", "wo-group", "wo-f-assignee", "wo-col-by", "wo-view-save", "wo-f-repo", "wo-f-source"]) expect(document.getElementById(id)).toBeNull();
    expect(document.getElementById("wo-mode-table")).toBeTruthy();
    expect(document.querySelectorAll("#wo-table thead .th-arrow-idle").length).toBeGreaterThan(3);
    expect(Array.from(document.querySelectorAll("#wo-table thead th")).map((t) => t.textContent?.replace(/[↑↓↕]/g, "").trim())).toEqual(["", "ID", "Title", "Class", "Station", "Needs", "Activity", ""]);
  });

  it("the state chip says Queued for a waiting work order with no gate and Gate <id> for one waiting at a gate", async () => {
    const gated = { ...wo, id: "WO-3401", state: "waiting", gates: { G2: { status: "waiting", approvals: [], rejections: [], checks: [] } } };
    const queued = { ...wo, id: "WO-3402", state: "waiting", gates: {} };
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([gated, queued]) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-3401");
    const rows = Array.from(document.querySelectorAll("#wo-table tbody tr")).map((r) => r.textContent ?? "");
    expect(rows.find((r) => r.includes("WO-3401"))).toMatch(/Gate G2/);
    expect(rows.find((r) => r.includes("WO-3402"))).toMatch(/Queued/);
    expect(document.body.textContent).not.toMatch(/Waiting on gate/);
  });

  it("links the id to the record, opens the record from the row, and shows the plain station and Gate <id> chip", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([{ ...wo, state: "waiting", station: 2, gates: { G2: { status: "waiting", approvals: [], rejections: [], checks: [] } } }]) }) });
    mount(<WorkOrdersView />);
    const link = (await screen.findByText("WO-2398")).closest("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/p/payments/record/WO-2398");
    expect(document.body.textContent).toMatch(/Gate G/);
    expect(document.body.textContent).not.toMatch(/S\d /);
    fireEvent.click(document.querySelector("#wo-table tbody tr td:nth-child(4)") as HTMLElement);
    expect(window.location.hash).toBe("#/p/payments/record/WO-2398");
    expect(document.querySelector(".drawer")).toBeNull();
  });

  it("selecting rows shows the banner with Set priority (a dialog), Park and Clear; Park asks first and parks each", async () => {
    const calls = mockApi({
      "GET /api/v1/projects/payments/work-orders": () => ({ body: page(WOS.slice(0, 3)) }),
      "POST /api/v1/work-orders/WO-2398/park": () => ({ body: { ok: true, msg: "Parked." } }),
    });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-2398");
    expect(document.getElementById("wo-bulk")).toBeNull();
    fireEvent.click(screen.getByLabelText("Select WO-2398"));
    const bar = document.getElementById("wo-bulk") as HTMLElement;
    expect(bar.textContent).toMatch(/1\s*selected/);
    // Set priority opens the prototype's dialog (a Priority select, Cancel, Apply)
    fireEvent.click(document.getElementById("wo-bulk-prio") as HTMLElement);
    const pdlg = await waitFor(() => { const e = document.querySelector<HTMLElement>(".dlg"); if (!e) throw new Error("no dialog"); return e; });
    expect(pdlg.textContent).toMatch(/Set priority/);
    expect(pdlg.querySelector("#wo-bulk-prio-select")).toBeTruthy();
    expect(pdlg.querySelector('[aria-label="Close dialog"]')).toBeNull();
    expect(Array.from(pdlg.querySelectorAll("button")).map((b) => b.textContent)).toEqual(expect.arrayContaining(["Cancel", "Apply"]));
    fireEvent.click(Array.from(pdlg.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".dlg")).toBeNull());
    fireEvent.click(document.getElementById("wo-bulk-park") as HTMLElement);
    expect(await screen.findByText("Park 1 work order?")).toBeTruthy();
    const dlg = document.querySelector(".dlg") as HTMLElement;
    // the Park dialog is a plain confirm: no reason field
    expect(dlg.querySelector("textarea,input")).toBeNull();
    // prototype shape: no eyebrow, no close X, the sentence is the sub line, Cancel is the bordered secondary button
    expect(dlg.querySelector(".kicker")).toBeNull();
    expect(dlg.querySelector('[aria-label="Close dialog"]')).toBeNull();
    expect(dlg.querySelector(".dlg-sub")?.textContent).toContain("Parked work orders stop moving");
    expect((Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "Cancel") as HTMLElement).className).not.toContain("ghost");
    fireEvent.click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "Park") as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/work-orders/WO-2398/park")).toBe(true));
    await waitFor(() => expect(document.getElementById("wo-bulk")).toBeNull());
    fireEvent.click(screen.getByLabelText("Select WO-2398"));
    fireEvent.click(document.getElementById("wo-bulk-clear") as HTMLElement);
    expect(document.getElementById("wo-bulk")).toBeNull();
  });

  it("New work order goes to the Console screen; Export CSV writes every matching row and says how many", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page(WOS.slice(0, 3)) }) });
    mount(<WorkOrdersView />);
    await screen.findByText("WO-2398");
    fireEvent.click(document.getElementById("wo-new") as HTMLElement);
    expect(window.location.hash).toBe("#console");
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:x";
    fireEvent.click(document.getElementById("wo-export") as HTMLElement);
    expect(await screen.findByText("Exported 3 rows")).toBeTruthy();
  });

  it("explains an empty result and clears the filters", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([], null, 0) }) });
    mount(<WorkOrdersView />);
    fireEvent.change(await screen.findByLabelText("Priority"), { target: { value: "P1" } });
    expect(await screen.findByText("Nothing matches")).toBeTruthy();
    expect(screen.getByText("Try clearing a filter or searching for something else.")).toBeTruthy();
    expect(document.querySelector("#wo-empty .ei")).toBeTruthy();
    fireEvent.click(document.getElementById("wo-clear") as HTMLElement);
    await waitFor(() => expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("all"));
    expect(qs().get("pri")).toBeNull();
  });
});

describe("New work order", () => {
  const submitOk = (_c: Call) => ({ body: { ok: true, msg: "WO-3000 submitted.", id: "WO-3000", wo: "WO-3000", classification: wo?.cls } });
  const traveler = () => ({ body: { ...wo, id: "WO-3000", title: "Fix refund crash", clsConfidence: 0.91, clsRationale: "The request describes broken behaviour.", clsSuggested: "bug", cls: "bug", requestedCls: null, conv: { questions: [1, 2, 3], misses: [], messages: [], raised: [], done: false }, version: 1 } });

  async function open(extra: Record<string, (c: Call) => { status?: number; body: unknown } | undefined> = {}, o: Parameters<typeof mockApi>[1] = {}) {
    const calls = mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([]) }), "GET /api/v1/work-orders/WO-3000": traveler, ...extra }, o);
    mount(<ConsoleSubmitView />);
    await screen.findByLabelText(/^Title/);
    return calls;
  }

  it("submits once with an Idempotency-Key even when the button is clicked twice, then shows the classification and route", async () => {
    const calls = await open({ "POST /api/v1/projects/payments/work-orders": submitOk });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Refund crashes on a zero amount. Steps to reproduce: post zero." } });
    expect(await screen.findByText("Predicted class")).toBeTruthy();
    expect(document.getElementById("nwo-kv")?.textContent).toMatch(/Confidence\d+%/);
    const submit = document.getElementById("nwo-submit") as HTMLElement;
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders")).toHaveLength(1));
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/projects/payments/work-orders") as Call;
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({ repo: "payments-api", title: "Fix refund crash", source: "console", priority: "P2" });
    // like the prototype: a toast with the number, then the new record
    expect(await screen.findByText("Submitted WO-3000. It is in the Intake queue.")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/p/payments/record/WO-3000"));
  });

  it("shows the server's refusal inline and keeps the dialog open", async () => {
    await open({ "POST /api/v1/projects/payments/work-orders": () => ({ status: 409, body: { ok: false, msg: "Payments Platform is halted (andon): duplicate refunds." } }) });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Fix refund crash" } });
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText(/is halted \(andon\)/)).toBeTruthy();
    expect(screen.getByLabelText(/^Title/)).toBeTruthy();
  });

  it("clears the inline title error as soon as a title is typed", async () => {
    await open();
    fireEvent.click(document.getElementById("nwo-submit") as HTMLElement);
    expect(await screen.findByText("Title is required.")).toBeTruthy();
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

describe("Console form (ops2 round 2)", () => {
  it("lists only repositories that can take work, by their plain names, and every attachment has a remove button", async () => {
    const mixed = REPOS.map((r, i) => ({ ...r, onboarding: { ...r.onboarding, stage: i === 0 ? "ready" : "assessed", exception: null } }));
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: page([]) }), "GET /api/v1/projects/payments/repos": () => ({ body: mixed }) });
    mount(<ConsoleSubmitView />);
    await screen.findByLabelText(/^Title/);
    await waitFor(() => expect((document.getElementById("nwo-repo") as HTMLSelectElement).options.length).toBeGreaterThan(0));
    const labels = Array.from((document.getElementById("nwo-repo") as HTMLSelectElement).options).map((o) => o.textContent ?? "");
    expect(labels).toHaveLength(1);
    expect(labels[0]).not.toMatch(/not ready/);
    // attachments are names kept by the form: the remove button sits on each
    expect(document.getElementById("nwo-attach")).toBeTruthy();
  });
});
