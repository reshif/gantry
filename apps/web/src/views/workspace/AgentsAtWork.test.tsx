import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../../lib/prefs";
import { AgentsAtWork } from "./AgentsAtWork";
import { mockApi, mount, resetApp } from "../floor/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agents at work (prototype workspace)", () => {
  it("draws one card per station agent with the run it is working on, and filters by activity", async () => {
    mockApi();
    mount(<AgentsAtWork />);
    expect(await screen.findByText("Agents at work")).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll(".ws-card").length).toBeGreaterThan(5));
    expect(document.querySelector(".ws-card .tok-stream")).toBeTruthy();
    const all = document.querySelectorAll(".ws-card").length;
    fireEvent.change(document.getElementById("ws-act")!, { target: { value: "idle" } });
    await waitFor(() => expect(document.querySelectorAll(".ws-card").length).toBeLessThan(all));
  });

  it("says the floor is not visible on a 403, instead of showing no agents", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<AgentsAtWork />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });
});
