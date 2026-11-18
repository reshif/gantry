import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordView from "./record";
import ChangesView from "./changes";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { readsFor, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const W = waitingWo;

async function show(extra: Parameters<typeof mockApi>[0] = {}, hash = `#record/${W.id}`) {
  const calls = mockApi({ ...readsFor(W), ...extra });
  window.location.hash = hash;
  mount(<RecordView />);
  await screen.findByRole("toolbar", { name: "Work order actions" }, { timeout: 4000 });
  return calls;
}

describe("Work order page", () => {
  it("puts the title, route and actions in the header and the document and activity in tabs", async () => {
    await show();
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    // the prototype has no route disclosure between the chips and the tabs
    expect(screen.queryByText(/Route of this work order/i)).toBeNull();
    expect(screen.getByRole("tab", { name: "Document" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe("false");
    // Traveler and Changes sit beside the decision; everything else is in one Actions menu
    expect(document.getElementById("rec-traveler")).toBeTruthy();
    expect(document.getElementById("rec-changes")).toBeTruthy();
  });

  it("has the prototype crumb: no drawing number, no All records link", async () => {
    await show();
    const crumb = document.querySelector(".kicker")?.textContent ?? "";
    expect(crumb).toMatch(/Work orders\s*\/\s*WO-/);
    expect(crumb).not.toMatch(/REC-11|All records/i);
    expect(document.getElementById("rec-all")).toBeNull();
  });

  it("lists the prototype's Actions menu: Edit title, Change priority, Send back, Park, then a divider and Kill", async () => {
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent ?? "");
    expect(items[0]).toMatch(/Edit title/);
    expect(items[1]).toMatch(/Change priority/);
    expect(items[2]).toMatch(/Send back/);
    expect(items[3]).toMatch(/Reassign agent/);
    expect(items[4]).toMatch(/Park in a bay|Resume/);
    expect(items[items.length - 1]).toMatch(/Kill work order/);
    expect(items).toHaveLength(6);
    expect(items.some((t) => /Open conversation|Copy link|Halt repo/.test(t))).toBe(false);
  });

  it("opens the Traveler page, not the drawer", async () => {
    await show();
    fireEvent.click(document.getElementById("rec-traveler") as HTMLElement);
    await waitFor(() => expect(window.location.hash).toContain(`traveler/${W.id}`));
    expect(window.location.search).not.toContain("traveler=");
  });

  it("labels the decision Approve and Reject, and Approve asks first with the gate's purpose", async () => {
    await show();
    const approve = document.getElementById("trv-approve") as HTMLElement;
    expect(approve.textContent).toBe("Approve");
    expect(document.getElementById("trv-reject")?.textContent).toBe("Reject");
    fireEvent.click(approve);
    expect(await screen.findByText(new RegExp(`^Approve .+ for ${W.id}$`))).toBeTruthy();
  });

  it("keeps the tab in the address (?tab=) and opens it from there", async () => {
    await show({}, `#record/${W.id}?tab=activity`);
    expect(screen.getByRole("tab", { name: /^Activity/ }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Timeline")).toBeTruthy();
    expect(screen.getByText("Conversation")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Gates/ }));
    await waitFor(() => expect(window.location.hash).toContain("tab=gates"));
  });

  it("shows the ten Properties rows and nothing else", async () => {
    await show();
    const keys = [...document.querySelectorAll("#dz-side dt")].map((d) => d.textContent);
    expect(keys).toEqual(["Station", "Class", "Priority", "Repo", "SLA due", "Cost", "Tokens", "PR", "Diff", "Tests"]);
    expect(screen.queryByText("Waiting on you")).toBeNull();
    expect(screen.queryByText(/An agent is working/)).toBeNull();
  });

  it("links the repo to its dossier", async () => {
    await show();
    const link = document.querySelector("#dz-side dd a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/dossier/");
  });

  it("shows the prototype's empty state for a work order that does not exist", async () => {
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }) });
    window.location.hash = `#record/${W.id}`;
    mount(<RecordView />);
    expect(await screen.findByText(`${W.id} does not exist`, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work orders" })).toBeTruthy();
    expect(screen.queryByText("Work order records")).toBeNull();
  });
});

describe("Work order page: links, viewers and kills", () => {
  it("degrades cleanly for a viewer without access to the conversation", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/session`]: () => ({ status: 403, body: { ok: false, msg: "No access." } }) });
    expect(screen.getByRole("heading", { level: 1, name: W.title })).toBeTruthy();
    expect(document.getElementById("dz-head")?.textContent).not.toMatch(/is next/);
  });

  it("keeps the station documents and the export behind ?full=1 (opened by Open full record), not in the prototype's Document tab", async () => {
    await show();
    expect(document.getElementById("dz-docs")).toBeNull();
    expect(document.getElementById("rec-copy")).toBeNull();
    cleanup();
    await show({}, `#record/${W.id}?full=1`);
    expect(document.getElementById("dz-docs")?.querySelector("summary")?.textContent).toMatch(/Station documents/);
    expect(document.getElementById("rec-copy")).toBeTruthy();
  });

  it("labels the decline button Reject and asks for a note on Approve and a reason on Reject (prototype dialogs)", async () => {
    await show();
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
    fireEvent.click(document.getElementById("trv-approve") as HTMLElement);
    expect(await screen.findByLabelText(/Note \(optional\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText(/Note \(optional\)/)).toBeNull());
    fireEvent.click(reject);
    expect(await screen.findByText(/Say what must change\./)).toBeTruthy();
    expect(document.getElementById("rj-submit")?.textContent).toMatch(/^Reject$/);
    expect(screen.getByLabelText(/Reason \(required\)/)).toBeTruthy();
  });

  it("opens the Edit title and Change priority dialogs from the Actions menu", async () => {
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Edit title/ }));
    expect(await screen.findByLabelText(/Title/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText(/^Title/)).toBeNull());
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Change priority/ }));
    expect(await screen.findByLabelText(/Priority/)).toBeTruthy();
  });

  it("opens the Send back dialog from the Actions menu", async () => {
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Send back to a station/ }));
    expect(await screen.findByLabelText(/What to fix \(required\)/)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: /^Send back$/ })).toBeTruthy();
    expect(screen.getByLabelText("Station")).toBeTruthy();
  });

  it("opens the prototype Kill confirm: 'Kill WO-x?' with a danger Kill button", async () => {
    await show();
    fireEvent.click(document.getElementById("dz-actions") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Kill work order/ }));
    expect(await screen.findByText(/The work order stops and cannot restart\./)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: new RegExp(`^Kill ${W.id}\\?$`) })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kill" })).toBeTruthy();
  });

  it("puts Approve and Reject on the waiting gate row of the Gates tab", async () => {
    await show({}, `#record/${W.id}?tab=gates`);
    await screen.findByText(/^1–\d+ of \d+$/);
    const row = Array.from(document.querySelectorAll("#dz-gates tbody tr")).find((r) => r.querySelector('[id^="gt-approve-"]'));
    expect(row).toBeTruthy();
    expect(row?.querySelector('[id^="gt-reject-"]')).toBeTruthy();
  });

  it("shows gate kinds in lower case with the 1-n of N footer", async () => {
    await show({}, `#record/${W.id}?tab=gates`);
    expect(await screen.findByText(/^1–\d+ of \d+$/)).toBeTruthy();
    expect(screen.queryByText("Human")).toBeNull();
  });
});

describe("Changes page", () => {
  it("shows counts and the plan, with the crumb as the way back (no Back button, no drawing number)", async () => {
    mockApi({ ...readsFor(W) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    expect(await screen.findByRole("heading", { name: `Changes · ${W.id}` }, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("chg-back")).toBeNull();
    expect(document.querySelector(".kicker")?.textContent).not.toMatch(/CHG-14/);
    expect(document.querySelector(".kicker a[href*='record']")).toBeTruthy();
    // no old-format "full change review" disclosure under the prototype's panels
    expect(document.getElementById("chg-full")).toBeNull();
  });

  it("does not crash on a commit that lists no files (record with a PR)", async () => {
    mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/changes`]: () => ({ body: { pullRequests: [], commits: [{ sha: "abc1234", message: "m", author: null, at: null }], files: [], patches: [] } }) });
    window.location.hash = `#record/${W.id}?full=1`;
    mount(<RecordView />);
    expect(await screen.findByText("Completeness", {}, { timeout: 4000 })).toBeTruthy();
  });

  it("shows the prototype's empty state for a work order that does not exist", async () => {
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    expect(await screen.findByText("That work order does not exist.", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Work orders" })).toBeTruthy();
  });

  it("does not crash when the record arrives without a code section", async () => {
    mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}/record`]: () => ({ body: {} }), [`GET /api/v1/work-orders/${W.id}/changes`]: () => ({ status: 404, body: { ok: false, msg: "none" } }) });
    window.location.hash = `#changes/${W.id}`;
    mount(<ChangesView />);
    await waitFor(() => expect(screen.queryByText(/failed to render/i)).toBeNull());
    expect(await screen.findByRole("heading", { name: /Changes/ }, { timeout: 4000 })).toBeTruthy();
  });

  it("without an id shows the Changes index with search, a Checks filter and a count", async () => {
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [{ ...W, diff: { plus: 3, minus: 1, files: 2 } }], next: null, total: 1 } }) });
    window.location.hash = "#/p/payments/changes";
    mount(<ChangesView />);
    expect(await screen.findByRole("heading", { name: "Changes" }, { timeout: 4000 })).toBeTruthy();
    expect(await screen.findByText("1 change", {}, { timeout: 4000 })).toBeTruthy();
    expect(document.getElementById("chg-q")).toBeTruthy();
    expect(document.getElementById("chg-f-checks")).toBeTruthy();
    expect((document.getElementById("chg-q") as HTMLInputElement).placeholder).toBe("Search…");
    expect(document.querySelector(".kicker")?.textContent).toMatch(/GNT-CHG-14/);
    expect(await screen.findByText(/^1–1 of 1$/)).toBeTruthy();
    expect(await screen.findByText(W.id)).toBeTruthy();
    for (const c of ["Work order", "Repo", "PR", "Checks", "Diff", "Files"]) expect(screen.getAllByText(c).length).toBeGreaterThan(0);
  });
});
