import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenTraveler } from "../shell/useTraveler";
import { setTravelerTab } from "./traveler/state";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { allow, deny, posts, readsFor, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const W = waitingWo;
const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";

function Opener({ tab }: { tab?: string }) {
  const open = useOpenTraveler();
  return <button type="button" id="open-trv" onClick={() => open(W.id, tab)}>open</button>;
}
async function show(extra: Parameters<typeof mockApi>[0] = {}, o: Parameters<typeof mockApi>[1] = {}, tab?: string) {
  const calls = mockApi({ ...readsFor(W), ...extra }, o);
  mount(<Opener tab={tab} />);
  await new Promise((r) => setTimeout(r, 30)); // the hash reset of resetApp closes a drawer opened in the same tick
  fireEvent.click(screen.getByText("open"));
  await screen.findByRole("heading", { name: W.title }, { timeout: 4000 });
  return calls;
}

describe("Traveler drawer in the URL", () => {
  it("writes the open work order and tab to the URL (F-15) and takes them out when it closes", async () => {
    await show();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("traveler")).toBe(W.id));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("ttab")).toBe("history"));
    fireEvent.click(document.getElementById("trv-close") as HTMLElement);
    await waitFor(() => expect(window.location.search).toBe(""));
    setTravelerTab("journey"); // the tab is remembered across drawers: leave it as the other tests expect it
  });
});

describe("Traveler drawer", () => {
  it("shows the position, the waiting gate with its progress and the title block", async () => {
    await show();
    expect(await screen.findByText("Traveler · routing sheet · Payments Platform")).toBeTruthy();
    expect(await screen.findByText(/waiting \(0 of 1\)/)).toBeTruthy();
    // a waiting gate is worded as what it needs, never as the outcome it waits for ("Spec approved")
    expect((await screen.findByText(/waiting \(0 of 1\)/)).textContent).toMatch(/^[\w+]+ (Approve|Confirm|Review|Check|Wait|Decide)/);
    expect(screen.getByText("Coding slot")).toBeTruthy();
  });

  it("approves the waiting gate with the work order version in If-Match", async () => {
    const calls = await show({ [`POST /api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`]: () => ({ body: { ok: true, msg: "Approved." } }) });
    const btn = await screen.findByRole("button", { name: /Approve/ });
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(posts(calls, `/api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`)[0]!.headers["if-match"]).toBe("7");
    expect(await screen.findByText("Approved.")).toBeTruthy();
  });

  it("locks Approve with the reason from the decision point and sends nothing when clicked", async () => {
    const calls = await show({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, {}, { approve: deny("No role held in Payments includes 'Approve gates'.", "Needs Line Lead") }) }) });
    const btn = await screen.findByRole("button", { name: /Approve/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("data-reason")).toContain("Needs Line Lead");
    fireEvent.click(btn);
    expect(calls.filter((c) => c.method === "POST" && c.path.includes("/approve"))).toHaveLength(0);
  });

  it("shows a stale refusal from the server instead of pretending it worked", async () => {
    const calls = await show({ [`POST /api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`]: () => ({ status: 409, body: { ok: false, msg: `${W.id} is no longer waiting at ${gate} on that instance.`, current: { instance: `${W.id}:${gate}:2`, gate, wo: W.id } } }) });
    await screen.findByRole("button", { name: /Approve/ });
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === `/api/v1/work-orders/${W.id}`).length;
    const before = reads();
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // The person is told what changed and that nothing was decided, and the screen refetches.
    expect(await screen.findByText(/no longer waiting.*It is now at instance 2\. Nothing was decided\. The screen was refreshed/)).toBeTruthy();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("refuses moves while a stop covers the work order and says why", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, { stop: { id: "project:payments:1", scope: "project", mode: "halt", reason: "Andon: flaky CI" } }, { approve: null }) }) });
    expect((await screen.findAllByText(/Andon: flaky CI/)).length).toBeGreaterThan(0);
    const park = screen.getByRole("button", { name: /Move to bay/ });
    expect(park.getAttribute("aria-disabled")).toBe("true");
    expect(park.getAttribute("data-reason")).toContain("Andon: flaky CI");
  });

  it("lets a permitted person restore a killed work order: its own kill is not a reason to lock Restore", async () => {
    const killed = { ...W, state: "killed" } as typeof W;
    await show({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(killed, { stop: { id: `workorder:${W.id}`, scope: "wo", mode: "kill", reason: "Stop it" } }, { approve: null }) }) });
    const btn = await screen.findByRole("button", { name: new RegExp(`Restore ${W.id}`) });
    expect(btn.getAttribute("aria-disabled")).toBeNull();
  });

  it("locks Restore on a killed work order while a wider stop (the project) covers it", async () => {
    const killed = { ...W, state: "killed" } as typeof W;
    await show({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(killed, { stop: { id: "project:payments", scope: "project", mode: "kill", reason: "Plant down" } }, { approve: null }) }) });
    const btn = await screen.findByRole("button", { name: new RegExp(`Restore ${W.id}`) });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("data-reason")).toContain("Restore the project first.");
  });

  it("rejects a gate with a reason of at least five characters", async () => {
    const path = `/api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/reject`;
    const calls = await show({ [`POST ${path}`]: () => ({ body: { ok: true, msg: "Rejected." } }) });
    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));
    const ta = await screen.findByPlaceholderText("What must change before this passes?");
    fireEvent.change(ta, { target: { value: "no" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    expect(posts(calls, path)).toHaveLength(0);
    fireEvent.change(ta, { target: { value: "The plan misses the rollback." } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" }).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ reason: "The plan misses the rollback." });
  });

  it("sends the work order back to an earlier station with the note", async () => {
    const path = `/api/v1/work-orders/${W.id}/send-back`;
    const calls = await show({ [`POST ${path}`]: () => ({ body: { ok: true, msg: "Sent back." } }) });
    fireEvent.click(await screen.findByRole("button", { name: /Send back/ }));
    fireEvent.change(await screen.findByLabelText("What to fix (required)"), { target: { value: "Cover the retry case" } });
    fireEvent.click(document.getElementById("sb-submit") as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ note: "Cover the retry case" });
    expect(typeof posts(calls, path)[0]!.body?.toStation).toBe("string");
  });

  it("moves to a bay with a reason and returns from it", async () => {
    const path = `/api/v1/work-orders/${W.id}/park`;
    const calls = await show({ [`POST ${path}`]: () => ({ body: { ok: true, msg: "Moved." } }) });
    fireEvent.click(await screen.findByRole("button", { name: /Move to bay/ }));
    fireEvent.change(await screen.findByLabelText("Reason (required)"), { target: { value: "Waiting for the vendor" } });
    fireEvent.click(document.getElementById("park-submit") as HTMLElement);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ reason: "Waiting for the vendor" });
    cleanup();
    vi.unstubAllGlobals();
    const parked = travelerOf({ ...W, bay: "hold", bayFrom: "spec", bayReason: "Waiting", state: "parked" } as typeof W, {}, { approve: null });
    const c2 = mockApi({ ...readsFor(W, parked), [`POST /api/v1/work-orders/${W.id}/unpark`]: () => ({ body: { ok: true, msg: "Back at Spec." } }) });
    mount(<Opener />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(await screen.findByRole("button", { name: /Return to/ }));
    fireEvent.change(await screen.findByPlaceholderText("What changed?"), { target: { value: "Vendor replied" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Return to belt" }).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(c2, `/api/v1/work-orders/${W.id}/unpark`)).toHaveLength(1));
  });

  it("retries a failed work order", async () => {
    const failed = travelerOf({ ...W, state: "failed", failReason: "Spec did not compile" } as typeof W, {}, { approve: null });
    const calls = mockApi({ ...readsFor(W, failed), [`POST /api/v1/work-orders/${W.id}/retry`]: () => ({ body: { ok: true, msg: "Running again." } }) });
    mount(<Opener />);
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByText("Spec did not compile")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/retry`)).toHaveLength(1));
  });

  it("switches tabs and opens a requested tab", async () => {
    await show({}, {}, "brief");
    expect(await screen.findByText("Estimate and route")).toBeTruthy();
    fireEvent.click(document.getElementById("trv-tab-history") as HTMLElement);
    expect(await screen.findByText("Audit ledger")).toBeTruthy();
    expect(screen.getByText("Floor log")).toBeTruthy();
  });

  it("explains a work order the viewer cannot see", async () => {
    mockApi({ [`GET /api/v1/work-orders/${W.id}`]: () => ({ status: 404, body: { ok: false, msg: "No such work order." } }) });
    mount(<Opener />);
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByText(`No work order ${W.id}`)).toBeTruthy();
  });
});
void allow;
