import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../lib/prefs";
import ConsoleSubmitView from "./console-submit";
import { mockApi, mount, resetApp } from "./floor/testkit";

beforeEach(() => {
  resetApp();
  updatePrefs({ project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Console (submit a work order, prototype layout)", () => {
  it("shows the form beside the route preview and recent submissions, and validates the title before submitting", async () => {
    const cs = mockApi();
    mount(<ConsoleSubmitView />);
    expect(await screen.findByText("New work order")).toBeTruthy();
    expect(screen.getByText("Route preview")).toBeTruthy();
    expect(screen.getByText("Recent submissions")).toBeTruthy();
    expect(document.querySelector("form.card")).toBeTruthy();
    const submit = await screen.findByRole("button", { name: "Submit work order" });
    await waitFor(() => expect(submit.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(submit);
    expect(await screen.findByText("Give the work order a title.")).toBeTruthy();
    expect(cs.some((c) => c.method === "POST" && c.path.endsWith("/work-orders"))).toBe(false);
  });
});
