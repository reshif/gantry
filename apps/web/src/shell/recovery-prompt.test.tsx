import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, mount, resetApp } from "../views/floor/testkit";
import { RecoveryPrompt } from "./RecoveryPrompt";

beforeEach(() => resetApp());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pending = { "GET /api/v1/security/recovery": () => ({ body: { pending: true, address: "203.0.113.9", signedInAt: Date.now() } }) };

describe("allow-list recovery prompt", () => {
  it("after a recovery sign-in it names the address and asks; Add sends add:true to the confirm route", async () => {
    const calls = mockApi({ ...pending, "POST /api/v1/security/recovery/confirm": () => ({ body: { ok: true, msg: "Added." } }) });
    mount(<RecoveryPrompt />);
    expect((await screen.findByText(/You signed in from 203\.0\.113\.9 outside the allow-list\./)).textContent).toBeTruthy();
    expect(document.getElementById("recovery-prompt")!.textContent).toContain("Add it?");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/security/recovery/confirm")?.body).toEqual({ add: true }));
  });

  it("Not now sends add:false and the list stays as it was", async () => {
    const calls = mockApi({ ...pending, "POST /api/v1/security/recovery/confirm": () => ({ body: { ok: true, msg: "Left." } }) });
    mount(<RecoveryPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/security/recovery/confirm")?.body).toEqual({ add: false }));
  });

  it("shows nothing when no recovery sign-in is waiting, or the server has no such route", async () => {
    mockApi({ "GET /api/v1/security/recovery": () => ({ body: { pending: false } }) });
    mount(<RecoveryPrompt />);
    await new Promise((r) => setTimeout(r, 60));
    expect(document.getElementById("recovery-prompt")).toBeNull();
    expect(document.getElementById("recovery-failed")).toBeNull();
  });

  it("a failed check says so with Try again, instead of looking like nothing is waiting", async () => {
    mockApi({ "GET /api/v1/security/recovery": () => ({ status: 500, body: { ok: false, msg: "boom" } }) });
    mount(<RecoveryPrompt />);
    expect(await screen.findByText(/Could not check whether a sign-in from outside the allow-list/)).toBeTruthy();
    expect(document.getElementById("recovery-retry")).toBeTruthy();
  });
});
