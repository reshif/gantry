import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMe } from "../api/queries";
import { useUI } from "../ui/overlay-context";
import { PAYMENTS, mockApi, mount, resetApp, type Call } from "../views/floor/testkit";
import { makeStopActions, type StopActions } from "./stopActions";

beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let actions: StopActions | null = null;
function Host() {
  const ui = useUI();
  const me = useMe();
  if (me) actions = makeStopActions(ui, me);
  return <div id="host">{me ? "ready" : "loading"}</div>;
}
const start = async (extra: Parameters<typeof mockApi>[0] = {}, o: Parameters<typeof mockApi>[1] = {}) => {
  const calls = mockApi(extra, o);
  mount(<Host />);
  await screen.findByText("ready");
  return calls;
};
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("Kill dialog", () => {
  it("shows what the kill touches, needs a reason and the typed name, then sends the stop", async () => {
    const calls = await start({
      "GET /api/v1/stops/impact": () => ({ body: { workOrders: 5, running: 2, slots: 1, prs: 3 } }),
      "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform killed (cancel)." } }),
    });
    act(() => actions?.kill("project", "payments"));
    expect(await screen.findByText("Kill Payments Platform")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Running agents").nextElementSibling?.textContent).toBe("2"));
    expect(screen.getByText("Open PRs").nextElementSibling?.textContent).toBe("3");
    expect(calls.find((c) => c.path === "/api/v1/stops/impact")?.query.get("scope")).toBe("project");
    // nothing is sent until reason and phrase are right
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(await screen.findByText(/reason of at least 5/)).toBeTruthy();
    fireEvent.change(document.getElementById("kill-reason") as HTMLElement, { target: { value: "Runaway agent spend" } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(await screen.findByText("Type Payments Platform exactly.")).toBeTruthy();
    expect(posts(calls, "/api/v1/stops")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Cancel in-flight work"));
    fireEvent.change(document.getElementById("kill-confirm") as HTMLElement, { target: { value: PAYMENTS.name } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    await waitFor(() => expect(posts(calls, "/api/v1/stops")).toHaveLength(1));
    expect(posts(calls, "/api/v1/stops")[0]?.body).toMatchObject({ scope: "project", id: "payments", mode: "kill", reason: "Runaway agent spend", inFlight: "cancel", confirmText: PAYMENTS.name });
    expect(await screen.findByText("Done: kill. Payments Platform killed (cancel).")).toBeTruthy();
  });

  it("asks for KILL FACTORY on the factory scope", async () => {
    const calls = await start({ "GET /api/v1/stops/impact": () => ({ body: { projects: 10, workOrders: 6, running: 2, slots: 2, prs: 0 } }), "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Factory killed." } }) });
    act(() => actions?.kill("factory", null));
    await screen.findByText("Emergency stop the factory");
    await waitFor(() => expect(screen.getByText("Projects").nextElementSibling?.textContent).toBe("10"));
    fireEvent.change(document.getElementById("kill-reason") as HTMLElement, { target: { value: "Credential leak suspected" } });
    fireEvent.change(document.getElementById("kill-confirm") as HTMLElement, { target: { value: "kill factory" } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(await screen.findByText("Type KILL FACTORY exactly.")).toBeTruthy();
    fireEvent.change(document.getElementById("kill-confirm") as HTMLElement, { target: { value: "KILL FACTORY" } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    await waitFor(() => expect(posts(calls, "/api/v1/stops")[0]?.body).toMatchObject({ scope: "factory", mode: "kill", confirmText: "KILL FACTORY" }));
  });

  it("is locked with the reason, and reads no impact, for someone without the right", async () => {
    const calls = await start({}, { denied: ["kill.project"] });
    act(() => actions?.kill("project", "payments"));
    await screen.findByText("Kill Payments Platform");
    await waitFor(() => expect(document.getElementById("kill-ok")?.getAttribute("aria-disabled")).toBe("true"));
    expect(document.querySelector(".lock-note")?.textContent).toMatch(/Factory Admin/);
    fireEvent.change(document.getElementById("kill-reason") as HTMLElement, { target: { value: "Runaway agent spend" } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(posts(calls, "/api/v1/stops")).toHaveLength(0);
    expect(calls.some((c) => c.path === "/api/v1/stops/impact")).toBe(false);
  });

  it("shows a stale or refused kill inline and keeps the dialog open", async () => {
    await start({ "GET /api/v1/stops/impact": () => ({ body: { workOrders: 0, running: 0, slots: 0, prs: 0 } }), "POST /api/v1/stops": () => ({ status: 409, body: { ok: false, msg: "Payments Platform is already killed." } }) });
    act(() => actions?.kill("project", "payments"));
    await screen.findByText("Kill Payments Platform");
    fireEvent.change(document.getElementById("kill-reason") as HTMLElement, { target: { value: "Runaway agent spend" } });
    fireEvent.change(document.getElementById("kill-confirm") as HTMLElement, { target: { value: PAYMENTS.name } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(await screen.findByText("Payments Platform is already killed.")).toBeTruthy();
    expect(document.getElementById("kill-reason")).toBeTruthy();
  });
});

describe("Step-up and the notify list", () => {
  const stepUp = { status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up", rule: { kind: "step-up", id: "STEP-UP", windowSec: 300, signedInSecAgo: 2520, action: "kill.factory" } } };
  beforeEach(() => window.sessionStorage.clear());

  it("explains the step-up refusal, keeps the draft across Sign in again, and restores it in the reopened dialog", async () => {
    const calls = await start({ "GET /api/v1/stops/impact": () => ({ body: { projects: 1, workOrders: 0, running: 0, slots: 0, prs: 0 } }), "POST /api/v1/stops": () => stepUp });
    act(() => actions?.kill("factory", null));
    await screen.findByText("Emergency stop the factory");
    fireEvent.change(document.getElementById("kill-reason") as HTMLElement, { target: { value: "Credential leak suspected" } });
    fireEvent.click(screen.getByLabelText("Cancel in-flight work"));
    fireEvent.change(document.getElementById("kill-confirm") as HTMLElement, { target: { value: "KILL FACTORY" } });
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    const note = await screen.findByText(/For safety, a kill needs a sign-in within the last 5 min\. You signed in 42 min ago\./);
    expect(note).toBeTruthy();
    expect(screen.queryByText("Sign in again to confirm this change.")).toBeNull();
    fireEvent.click(document.getElementById("stepup-go") as HTMLElement);
    const saved = JSON.parse(window.sessionStorage.getItem("gantry.stepup.draft") ?? "null");
    expect(saved).toMatchObject({ kind: "kill", scope: "factory", values: { reason: "Credential leak suspected", mode: "cancel", confirm: "KILL FACTORY" } });
    expect(posts(calls, "/api/v1/stops")).toHaveLength(1);
    // back from the sign-in: the same dialog, same typed values, nothing sent until the final click
    cleanup();
    await start({ "GET /api/v1/stops/impact": () => ({ body: { projects: 1, workOrders: 0, running: 0, slots: 0, prs: 0 } }), "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Factory killed." } }) });
    act(() => actions?.kill("factory", null));
    await screen.findByText("Emergency stop the factory");
    expect((document.getElementById("kill-reason") as HTMLTextAreaElement).value).toBe("Credential leak suspected");
    expect((document.getElementById("kill-confirm") as HTMLInputElement).value).toBe("KILL FACTORY");
    expect((screen.getByLabelText("Cancel in-flight work") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(document.getElementById("kill-ok") as HTMLElement);
    expect(await screen.findByText("Done: kill. Factory killed.")).toBeTruthy();
    expect(window.sessionStorage.getItem("gantry.stepup.draft")).toBeNull();
  });

  it("clears the draft when the dialog is cancelled", async () => {
    window.sessionStorage.setItem("gantry.stepup.draft", JSON.stringify({ kind: "kill", scope: "factory", id: null, values: { reason: "x y z w v" }, at: Date.now() }));
    await start({ "GET /api/v1/stops/impact": () => ({ body: { projects: 1, workOrders: 0, running: 0, slots: 0, prs: 0 } }) });
    act(() => actions?.kill("factory", null));
    await screen.findByText("Emergency stop the factory");
    fireEvent.click(screen.getByText("Cancel"));
    expect(window.sessionStorage.getItem("gantry.stepup.draft")).toBeNull();
  });

  it("restore shows the same prompt", async () => {
    await start({ "POST /api/v1/stops/factory%3A/restore": () => stepUp }, { me: { factory: { killed: { by: "p-asha", at: Date.now() - 60_000, reason: "Runaway", mode: "hold", restoreApprovals: [] } } } });
    act(() => actions?.restore("factory", null));
    await screen.findByText("Restore the factory");
    fireEvent.change(document.getElementById("rsn-text") as HTMLElement, { target: { value: "Credentials rotated" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    expect(await screen.findByText(/For safety, a restore needs a sign-in/)).toBeTruthy();
    expect(document.getElementById("stepup-go")).toBeTruthy();
  });

  it("lists only destinations that will be delivered; the rest are greyed with a link to Integrations", async () => {
    await start({
      "GET /api/v1/stops/impact": () => ({ body: { workOrders: 0, running: 0, slots: 0, prs: 0 } }),
      "GET /api/v1/projects/payments/routes/preview": () => ({ body: { event: "kill", items: [{ channel: "slack", target: "#incidents", deliverable: false, reason: "no slack connection is open to this project" }, { channel: "email", target: "project admins", deliverable: true, reason: "" }] } }),
    });
    act(() => actions?.kill("project", "payments"));
    await screen.findByText("Kill Payments Platform");
    await waitFor(() => expect(document.querySelectorAll("#notify-list li").length).toBe(2));
    const [first, second] = [...document.querySelectorAll("#notify-list li")];
    expect(first?.getAttribute("data-deliverable")).toBe("yes");
    expect(first?.textContent).toBe("email project admins");
    expect(second?.getAttribute("data-deliverable")).toBe("no");
    expect(second?.textContent).toMatch(/not configured/);
    expect(second?.querySelector("a")?.getAttribute("href")).toBe("#/integrations");
  });
});

describe("Restore dialog", () => {
  const killed = { by: "p-asha", at: Date.now() - 60_000, reason: "Runaway agent spend", mode: "hold", restoreApprovals: [] };
  it("quotes who killed it, needs a reason and reports that a second admin is still needed", async () => {
    const calls = await start({ "POST /api/v1/stops/factory%3A/restore": () => ({ body: { ok: true, msg: "Restore recorded (1 of 2). A second Factory Admin must approve.", pending: true } }) }, { me: { factory: { killed } } });
    act(() => actions?.restore("factory", null));
    await screen.findByText("Restore the factory");
    expect(document.querySelector(".dlg-sub")?.textContent).toMatch(/Killed by Asha Raman.*Runaway agent spend.*two Factory Admins/);
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    expect(await screen.findByText(/at least 5 characters/)).toBeTruthy();
    fireEvent.change(document.getElementById("rsn-text") as HTMLElement, { target: { value: "Credentials rotated" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(posts(calls, "/api/v1/stops/factory%3A/restore")).toHaveLength(1));
    expect(posts(calls, "/api/v1/stops/factory%3A/restore")[0]?.body).toMatchObject({ reason: "Credentials rotated" });
    expect(await screen.findByText(/A second Factory Admin must approve/)).toBeTruthy();
  });

  it("is locked for someone who may not restore", async () => {
    await start({}, { denied: ["restore.factory"], me: { factory: { killed } } });
    act(() => actions?.restore("factory", null));
    await screen.findByText("Restore the factory");
    await waitFor(() => expect(document.getElementById("rsn-ok")?.getAttribute("aria-disabled")).toBe("true"));
  });
});

describe("Halt dialog", () => {
  it("is the prototype dialog: no Andon eyebrow, a Reason marked (required) with the audit hint", async () => {
    await start({}, { me: { projects: [PAYMENTS] } });
    act(() => actions?.halt("payments"));
    await screen.findByText("Halt the line");
    expect(document.body.textContent).not.toMatch(/Andon ·/);
    expect(screen.getByText("(required)")).toBeTruthy();
    expect(screen.getByText("Recorded in the audit ledger.")).toBeTruthy();
  });

  it("needs 20 characters on a regulated project and sends a halt", async () => {
    const regulated = { ...PAYMENTS, regulated: true };
    const calls = await start({ "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform halted." } }) }, { me: { projects: [regulated] } });
    act(() => actions?.halt("payments"));
    await screen.findByText("Halt the line");
    fireEvent.change(document.getElementById("rsn-text") as HTMLElement, { target: { value: "Too short" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    expect(await screen.findByText(/at least 20 characters/)).toBeTruthy();
    fireEvent.change(document.getElementById("rsn-text") as HTMLElement, { target: { value: "Duplicate refunds reported by two customers" } });
    fireEvent.click(document.getElementById("rsn-ok") as HTMLElement);
    await waitFor(() => expect(posts(calls, "/api/v1/stops")[0]?.body).toMatchObject({ scope: "project", id: "payments", mode: "halt" }));
  });
});
