import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenTraveler } from "../shell/useTraveler";
import { anywayLabel, overrideKindOf, overrideWhy } from "./work/override";
import { modelName, shortModel } from "./console";
import { GateActions } from "./work/gate";
import { mockApi, mount, resetApp } from "./floor/testkit";
import { useMe } from "../api/queries";
import { makeStopActions } from "../shell/stopActions";
import { useUI } from "../ui/overlay-context";
import { deny, posts, readsFor, travelerOf, waitingWo } from "./traveler/testkit";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const W = waitingWo;
const gate = Object.entries(W.gates).find(([, g]) => g.status === "waiting")?.[0] ?? "G2";
const path = `/api/v1/gate-instances/${encodeURIComponent(`${W.id}:${gate}:1`)}/approve`;

function Opener() {
  const open = useOpenTraveler();
  return <button type="button" id="open-trv" onClick={() => open(W.id)}>open</button>;
}
async function show(approve: Record<string, unknown>) {
  const calls = mockApi({
    ...readsFor(W),
    [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, {}, { approve }) }),
    [`POST ${path}`]: () => ({ body: { ok: true, msg: "Approved." } }),
  });
  mount(<Opener />);
  await new Promise((r) => setTimeout(r, 30));
  fireEvent.click(screen.getByText("open"));
  await screen.findByRole("heading", { name: W.title }, { timeout: 4000 });
  return calls;
}

describe("Factory Admin override at a gate (the server's decision says override:true)", () => {
  it("reads the decision: only a refused decision flagged override is an override, and the words follow the gate", () => {
    expect(overrideKindOf({ allowed: false, override: true, overrideKind: "halt" })).toBe("halt");
    expect(overrideKindOf({ allowed: false, override: true, overrideKind: "freeze" })).toBe("freeze");
    expect(overrideKindOf({ allowed: false })).toBeNull();
    expect(overrideKindOf({ allowed: true, override: true })).toBeNull();
    expect(overrideWhy("halt")).toBe("The line is halted.");
    expect(overrideWhy("freeze")).toBe("A release freeze is on.");
    expect([anywayLabel("G2"), anywayLabel("G6"), anywayLabel("G0G1")]).toEqual(["Approve anyway", "Release anyway", "Confirm anyway"]);
  });

  it("shows Approve anyway during a halt, asks why and for a reason of at least 5 characters, then sends it", async () => {
    const calls = await show({ allowed: false, reason: "The line is halted.", needs: "override_reason", override: true, overrideKind: "halt" });
    const btn = await screen.findByRole("button", { name: /Approve anyway/ });
    expect(btn.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(btn);
    expect(await screen.findByText("The line is halted.")).toBeTruthy();
    const ok = () => document.getElementById("ap-submit")!;
    fireEvent.change(document.getElementById("ap-note")!, { target: { value: "abc" } });
    fireEvent.click(ok());
    expect(await screen.findByText("Give a reason of at least 5 characters.")).toBeTruthy();
    expect(posts(calls, path)).toHaveLength(0);
    fireEvent.change(document.getElementById("ap-note")!, { target: { value: "Hotfix for the payments outage" } });
    fireEvent.click(ok());
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ reason: "Hotfix for the payments outage" });
  });

  it("never offers the override to someone whose decision is a plain refusal: the control stays locked with its reason", async () => {
    await show(deny("The line is halted. Resume first.", "Resume the line"));
    expect(screen.queryByRole("button", { name: /anyway/ })).toBeNull();
    const btn = await screen.findByRole("button", { name: /Approve/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });
});

function RestoreOpener() {
  const ui = useUI();
  const me = useMe();
  return <button type="button" id="open-restore" onClick={() => me && makeStopActions(ui, me).restore("factory", null)}>restore</button>;
}
const KILLED = { killed: { by: "p-asha", at: Date.now() - 60000, reason: "Incident" } };

describe("Factory restore by the sole Factory Admin", () => {
  it("the dialog says restore with a reason, names no second admin, and sends the reason", async () => {
    const calls = mockApi({ "POST /api/v1/restore": () => ({ body: { ok: true, msg: "Restored." } }) }, { override: ["restore.factory"], me: { factory: KILLED } });
    mount(<RestoreOpener />);
    await waitFor(() => expect(document.getElementById("open-restore")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText("restore"));
    expect(await screen.findByText("Restore the factory with a reason")).toBeTruthy();
    expect(screen.getByText(/only Factory Admin, so you restore without a second person/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("needs two Factory Admins");
    expect(screen.getByRole("button", { name: "Restore with a reason" })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path !== "/api/v1/can")).toBe(false);
  });

  it("with two admins (no override in the decision) it is the ordinary restore that waits for a second person", async () => {
    mockApi({}, { me: { factory: KILLED } });
    mount(<RestoreOpener />);
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText("restore"));
    expect(await screen.findByText("Restore the factory")).toBeTruthy();
    expect(screen.queryByText("Restore the factory with a reason")).toBeNull();
    expect(screen.getByText(/Restoring the factory needs two Factory Admins/)).toBeTruthy();
  });
});

describe("Approve controls on Home and in the Inbox (GateActions)", () => {
  const card = { wo: W.id, gate, gateName: "Gate", gateLabel: gate, instance: `${W.id}:${gate}:1`, title: W.title, project: W.project } as never;
  it("an admin during a freeze sees Release anyway / Approve anyway with the reason box; the reason rides on the approve", async () => {
    const calls = mockApi({
      ...readsFor(W),
      [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, {}, { approve: { allowed: false, reason: "A release freeze is on.", needs: "override_reason", override: true, overrideKind: "freeze" } }) }),
      [`POST ${path}`]: () => ({ body: { ok: true, msg: "Approved." } }),
    });
    mount(<GateActions a={card} idPrefix="t" />);
    const btn = await screen.findByRole("button", { name: new RegExp(`(Approve|Release|Confirm) anyway ${W.id}`) });
    expect(btn.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(btn);
    expect(await screen.findByText("A release freeze is on.")).toBeTruthy();
    fireEvent.change(document.getElementById("gd-text")!, { target: { value: "no" } });
    fireEvent.click(document.getElementById("gd-ok")!);
    expect(await screen.findByText("Reason needs at least 5 characters.")).toBeTruthy();
    fireEvent.change(document.getElementById("gd-text")!, { target: { value: "Customer-facing fix" } });
    fireEvent.click(document.getElementById("gd-ok")!);
    await waitFor(() => expect(posts(calls, path)).toHaveLength(1));
    expect(posts(calls, path)[0]!.body).toMatchObject({ reason: "Customer-facing fix" });
  });

  it("everyone else gets the ordinary locked Approve", async () => {
    mockApi({ ...readsFor(W), [`GET /api/v1/work-orders/${W.id}`]: () => ({ body: travelerOf(W, {}, { approve: deny("A release freeze is on.", "Factory Admin") }) }) });
    mount(<GateActions a={card} idPrefix="t" />);
    const btn = await screen.findByRole("button", { name: new RegExp(`^Approve ${W.id}`) });
    await waitFor(() => expect(btn.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.queryByRole("button", { name: /anyway/ })).toBeNull();
  });
});

describe("Console header chip", () => {
  it("shows a short model name, not the vendor prefix or the date", () => {
    expect(shortModel("claude-sonnet-5-5-20260101")).toBe("sonnet-5-5");
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel("s")).toBe("s");
    // T-52 / T-33: the chip names the model ("Sonnet 5.5"), from the catalogue name when there is one
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelName("claude-sonnet-5-5-20260101")).toBe("Sonnet 5.5");
    expect(modelName("claude-opus-5-5", [{ id: "claude-opus-5-5", name: "Claude Opus 5.5 (Bedrock)" }])).toBe("Opus 5.5");
  });
});
