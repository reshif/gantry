import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { post, put, setCsrfToken, setStepUpHandler } from "../api/client";
import { OverlayProvider } from "./Overlay";
import { STEP_UP_MESSAGE, StepUpPopupDone, registerStepUpDraft, useInstallStepUp } from "./stepup";

const refusal = { status: 403, body: { ok: false, msg: "Sign in again to confirm this change.", needs: "step_up", rule: { kind: "step-up", id: "STEP-UP", windowSec: 900, signedInSecAgo: 3600 } } };
const okBody = { status: 200, body: { ok: true, msg: "Done." } };

function Host() {
  useInstallStepUp();
  return null;
}

interface Req { url: string; method: string; headers: Record<string, string>; body: unknown }
let reqs: Req[];
let answers: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  reqs = [];
  answers = [];
  setCsrfToken("c");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      reqs.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const a = answers.shift() ?? okBody;
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }),
  );
  render(
    <OverlayProvider>
      <Host />
    </OverlayProvider>,
  );
});
afterEach(() => {
  cleanup();
  setStepUpHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const popupWin = () => ({ close: vi.fn() }) as unknown as Window;
const tellOpener = (data: unknown, origin = window.location.origin) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, origin })));

describe("central step-up", () => {
  it("shows one prompt with the window and age, retries the original request once after the popup signs in, and the caller resolves with the retry", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal, okBody];
    const p = put("/api/v1/access/matrix/viewer/wo.submit", { on: true }, { ifMatch: 4 });
    expect(await screen.findByText(/within 15 min\)\. You signed in 1 h ago/)).toBeTruthy();
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    expect(open).toHaveBeenCalledWith("/auth/login?step_up=1&popup=1", "gantry-step-up", expect.any(String));
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(reqs).toHaveLength(2);
    expect(reqs[1]).toMatchObject({ method: "PUT", body: { on: true }, headers: expect.objectContaining({ "If-Match": "4" }) });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("repeats a create with the same Idempotency-Key", async () => {
    vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal, okBody];
    const p = post("/api/v1/roles", { name: "x" }, { idempotent: true });
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true });
    expect((await p).ok).toBe(true);
    expect(reqs[0]!.headers["Idempotency-Key"]).toBeTruthy();
    expect(reqs[1]!.headers["Idempotency-Key"]).toBe(reqs[0]!.headers["Idempotency-Key"]);
  });

  it("ignores a message from another origin", async () => {
    vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal, okBody];
    const p = post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true }, "https://evil.example");
    expect(reqs).toHaveLength(1);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true });
    expect((await p).ok).toBe(true);
  });

  it("a popup that reads as closed (COOP) shows a soft note, and a late success still completes the change", async () => {
    const win = { close: vi.fn(), closed: false } as unknown as { close: () => void; closed: boolean };
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    answers = [refusal, okBody];
    const p = post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    win.closed = true; // the browser hides the real state of a cross-origin-isolated popup
    await waitFor(() => expect(document.getElementById("stepup-error")?.textContent).toMatch(/closed before it finished/), { timeout: 3000 });
    expect(reqs).toHaveLength(1); // nothing was decided yet
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true }); // the real sign-in finishes later
    expect((await p).ok).toBe(true);
    expect(reqs).toHaveLength(2);
  });

  it("never retries twice: a second step-up refusal reaches the caller", async () => {
    vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal, refusal];
    const p = post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true });
    const r = await p;
    expect(r).toMatchObject({ ok: false, needs: "step_up" });
    expect(reqs).toHaveLength(2);
  });

  it("cancel resolves the caller with the refusal and sends nothing more", async () => {
    answers = [refusal];
    const p = post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-cancel")!);
    expect(await p).toMatchObject({ ok: false, needs: "step_up" });
    expect(reqs).toHaveLength(1);
  });

  it("a failed popup sign-in (another person) shows the error and cancel gives the caller that message", async () => {
    vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal];
    const p = post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: false, msg: "That sign-in was a different person." });
    expect(await screen.findByText(/different person/)).toBeTruthy();
    fireEvent.click(document.getElementById("stepup-cancel")!);
    expect(await p).toMatchObject({ ok: false, needs: "step_up" });
    expect(reqs).toHaveLength(1);
  });

  it("popup blocked: saves the registered draft and redirects the page to the step-up sign-in", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign, hash: "#floor", origin: orig.origin } });
    const off = registerStepUpDraft(() => ({ kind: "kill", scope: "factory", id: null, values: { reason: "typed" } }));
    answers = [refusal];
    void post("/api/v1/x", {});
    await screen.findByText(/recent sign-in/);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/auth/login?step_up=1&return_to=${encodeURIComponent("/#floor")}`));
    expect(JSON.parse(window.sessionStorage.getItem("gantry.stepup.draft") ?? "null")).toMatchObject({ kind: "kill", values: { reason: "typed" } });
    off();
    window.sessionStorage.clear();
    Object.defineProperty(window, "location", { configurable: true, value: orig });
  });

  it("two refusals at once share one prompt", async () => {
    vi.spyOn(window, "open").mockReturnValue(popupWin());
    answers = [refusal, refusal, okBody, okBody];
    const a = post("/api/v1/a", {});
    const b = post("/api/v1/b", {});
    await screen.findByText(/recent sign-in/);
    expect(screen.getAllByText("Sign in again to confirm")).toHaveLength(1);
    fireEvent.click(document.getElementById("stepup-go-popup")!);
    await tellOpener({ type: STEP_UP_MESSAGE, ok: true });
    expect((await a).ok && (await b).ok).toBe(true);
  });
});

describe("popup result page", () => {
  it("posts to the opener with the app origin as the target and closes", async () => {
    cleanup();
    vi.useFakeTimers();
    const post = vi.fn();
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    Object.defineProperty(window, "opener", { configurable: true, value: { postMessage: post } });
    render(<StepUpPopupDone ok msg="" />);
    expect(post).toHaveBeenCalledWith({ type: STEP_UP_MESSAGE, ok: true }, window.location.origin);
    vi.advanceTimersByTime(200);
    expect(close).toHaveBeenCalled();
    vi.useRealTimers();
    Object.defineProperty(window, "opener", { configurable: true, value: null });
  });
});
