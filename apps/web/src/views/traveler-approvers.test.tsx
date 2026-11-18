import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { useOpenTraveler } from "../shell/useTraveler";
import { AGENTS, mockApi, mount, resetApp } from "./floor/testkit";
import { deny, posts, readsFor, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const W = waitingWo;
const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";
const stationId = DEFAULT_CATALOG.stations[W.station]!.id;
const cur = W.history[W.history.length - 1]?.agent ?? "";

function Opener() {
  const open = useOpenTraveler();
  return <button type="button" id="open-trv" onClick={() => open(W.id)}>open</button>;
}
async function show(extra: Parameters<typeof mockApi>[0] = {}, o: Parameters<typeof mockApi>[1] = {}) {
  const calls = mockApi({ ...readsFor(W), ...extra }, o);
  mount(<Opener />);
  await new Promise((r) => setTimeout(r, 30));
  fireEvent.click(screen.getByText("open"));
  await screen.findByRole("heading", { name: W.title }, { timeout: 4000 });
  return calls;
}

const approvers = (over: Record<string, unknown> = {}) => ({
  gate, label: gate, name: "Gate", rule: { text: "Needs 2 approvals from Line Lead or Project Admin · the author can't approve", required: 2, sod: true, roles: [], people: [], conditions: [] },
  progress: { have: 0, need: 2, approvals: [], unmet: [], onlyRequester: false }, eligible: [{ id: "p-daniel", name: "Daniel Okafor", why: "Approver rule allows Project Admin.", away: false, oncall: false }],
  overrides: [{ id: "p-asha", name: "Asha Raman" }], satisfiable: false, warning: "This gate can't pass as configured: only 1 person is eligible and it needs 2.",
  viewerCanOverride: true, can: { editRule: true, editWhy: "", grantRole: true, grantWhy: "" }, ...over,
});

describe("Gate approver transparency", () => {
  it("shows the rule in plain words, progress, the eligible people and a warning when the gate cannot pass; the locked Approve says why inline; Approve as override uses the ordinary approve call", async () => {
    const path = `/api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`;
    const calls = await show({
      [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, {}, { approve: deny("Separation of duties: the author cannot approve.", "Someone other than the author") }) }),
      [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers() }),
      [`POST ${path}`]: () => ({ body: { ok: true, msg: "Approved." } }),
    });
    expect(await screen.findByText(/Needs 2 approvals from Line Lead or Project Admin/)).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();
    expect(screen.getByText("Daniel Okafor")).toBeTruthy();
    expect(screen.getByRole("alert", { name: "" }) ?? true).toBeTruthy();
    expect(document.getElementById("apr-warning")!.textContent).toMatch(/can't pass as configured/);
    expect(document.getElementById("trv-approve-why")!.textContent).toMatch(/Separation of duties/);
    expect(screen.getByRole("button", { name: "Edit rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Grant a role" })).toBeTruthy();
    expect(screen.getByText(/Factory Admins are eligible approvers like anyone else\. Asha Raman wrote this work order/)).toBeTruthy();
    expect(screen.queryByText(/may approve as an override/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve as override" }));
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
  });

  it("lists an eligible Factory Admin as a normal approver and shows no override line when none is needed", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers({ eligible: [{ id: "p-asha", name: "Asha Raman", why: "Factory Admin may approve any gate.", away: false, oncall: false }], overrides: [], satisfiable: true, warning: null, viewerCanOverride: false }) }) });
    expect(await screen.findByText("Asha Raman")).toBeTruthy();
    expect(document.getElementById("apr-warning")).toBeNull();
    expect(screen.queryByText(/override with a reason/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve as override" })).toBeNull();
  });

  it("says when the work order's class has its own count instead of the gate's base", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers({ rule: { text: "Needs 1 approval from Line Lead", required: 1, base: 2, classOverride: 1, sod: true, roles: [], people: [], conditions: [] }, progress: { have: 0, need: 1, approvals: [], unmet: [], onlyRequester: false } }) }) });
    expect(await screen.findByText("This work order's class needs 1 instead of the gate's base 2.")).toBeTruthy();
    expect(screen.getByText("0/1")).toBeTruthy();
  });

  it("Edit rule opens Project config on that gate's approvers", async () => {
    await show({ [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers() }) });
    fireEvent.click(await screen.findByRole("button", { name: "Edit rule" }));
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`project-config/approvers%2F${gate}$`)));
  });
});

describe("Open items before approving", () => {
  const dlg = (assumptions: unknown[], objections: unknown[]) => ({ [`GET /api/v1/work-orders/${W.id}/dialogue`]: () => ({ body: { questions: [], assumptions, objections } }) });
  const apr = { [`GET /api/v1/work-orders/${W.id}/gates/${gate}/approvers`]: () => ({ body: approvers() }) };
  it("lists open objections and assumptions in the drawer, and the link opens the work-order conversation", async () => {
    await show({ ...apr, ...dlg([{ id: "a1", status: "open", impact: "high" }], [{ id: "o1", status: "open" }, { id: "o2", status: "upheld" }]) });
    const note = await waitFor(() => { const n = document.getElementById("gate-notes"); expect(n).toBeTruthy(); return n!; });
    expect(note.textContent).toContain("1 objection not decided");
    expect(note.textContent).toContain("1 assumption not confirmed (some high impact)");
    fireEvent.click(screen.getByRole("button", { name: "1 objection not decided" }));
    await waitFor(() => expect(window.location.hash).toMatch(new RegExp(`conversations/${encodeURIComponent(W.id)}`)));
  });
  it("shows nothing when nothing is open, or when the read fails", async () => {
    await show({ ...apr, ...dlg([{ id: "a1", status: "confirmed", impact: "low" }], []) });
    await screen.findByText(/Needs 2 approvals/);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.getElementById("gate-notes")).toBeNull();
    cleanup();
    await show({ ...apr, [`GET /api/v1/work-orders/${W.id}/dialogue`]: () => ({ status: 500, body: { error: "x" } }) });
    await screen.findByText(/Needs 2 approvals/);
    expect(document.getElementById("gate-notes")).toBeNull();
  });
});

describe("Reassign", () => {
  const agent = (id: string, name: string) => ({ ...(AGENTS[0] as object), id, name, stations: [stationId], projects: "all", status: "active", version: "1.0.0", model: "m" });
  const open = async (agents: unknown[]) => {
    const calls = await show({ "GET /api/v1/agents": () => ({ body: agents }), [`POST /api/v1/work-orders/${W.id}/reassign`]: () => ({ body: { ok: true, msg: "Reassigned." } }) });
    fireEvent.click(await screen.findByRole("button", { name: /Reassign agent/ }));
    return calls;
  };
  it("with no other agent allowed there is no dead Reassign: it is locked with the reason inline and links to where to allow more", async () => {
    const calls = await open([agent(cur, "Current Agent")]);
    const note = await screen.findByText(/Nobody else can take/);
    expect(note).toBeTruthy();
    const submit = document.getElementById("ra-submit")!;
    expect(submit.getAttribute("aria-disabled") === "true" || (submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(posts(calls, `/api/v1/work-orders/${W.id}/reassign`)).toHaveLength(0);
    expect(screen.getByText(/No other agent is allowed to staff/)).toBeTruthy();
    fireEvent.click(document.getElementById("ra-open-agent")!);
    await waitFor(() => expect(window.location.hash).toMatch(/agents/));
  });
  it("with alternatives a different agent is preselected and Reassign sends it", async () => {
    const calls = await open([agent(cur, "Current Agent"), agent("ag-other", "Other Agent")]);
    const sel = (await screen.findByLabelText("Agent")) as HTMLSelectElement;
    expect(sel.value).toBe("ag-other");
    fireEvent.click(document.getElementById("ra-submit")!);
    await waitFor(() => expect(posts(calls, `/api/v1/work-orders/${W.id}/reassign`)).toHaveLength(1));
    expect(posts(calls, `/api/v1/work-orders/${W.id}/reassign`)[0]!.body).toMatchObject({ agent: "ag-other" });
  });
});
