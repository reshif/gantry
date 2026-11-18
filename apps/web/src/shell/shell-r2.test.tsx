import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../lib/router";
import { mockApi, mount, resetApp } from "../views/floor/testkit";
import { PaletteDialog } from "./Palette";
import { NotFoundPage, StatePreview } from "./StatePreview";
import { StatusBar } from "./StatusBar";

beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("hash router", () => {
  it("accepts the prototype's ?state preview after a single-segment route", () => {
    expect(parseHash("#home?state=loading")).toMatchObject({ id: "home", state: "loading" });
    expect(parseHash("#/p/payments/floor?state=empty")).toMatchObject({ id: "floor", project: "payments", state: "empty" });
    expect(parseHash("#home")).not.toHaveProperty("state");
  });
});

describe("state previews and 404", () => {
  it.each(["loading", "empty", "error", "forbidden", "conflict"] as const)("renders the %s preview under the page header", (state) => {
    render(<StatePreview state={state} eyebrow="Operate" title="Home" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Home");
    expect(document.querySelector(".page .card, .page .banner, .page .stack")).toBeTruthy();
  });
  it("the 404 page has the 404 eyebrow, the missing name and a Go Home button", () => {
    render(<NotFoundPage name="nowhere" />);
    expect(document.querySelector(".eyebrow")?.textContent).toBe("404");
    expect(screen.getByText("There is no “nowhere” page")).toBeTruthy();
    expect(screen.getByText("Go Home").getAttribute("href")).toBe("#home");
  });
});

describe("palette", () => {
  const labels = (): string[] => Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent ?? "");
  it("Submit a work order goes to the Console screen,", async () => {
    mockApi();
    mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "submit" } });
    await waitFor(() => expect(labels()).toContain("Submit a work order"));
    fireEvent.mouseDown(screen.getByText("Submit a work order"));
    await waitFor(() => expect(window.location.hash).toBe("#console"));
  });
  it("is capped at 40 results with no Sign out action", async () => {
    mockApi();
    mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
    await screen.findByRole("combobox", { name: "Search commands" });
    await waitFor(() => expect(labels().length).toBeGreaterThan(5));
    expect(labels().length).toBeLessThanOrEqual(40);
    expect(labels()).not.toContain("Sign out");
  });
});

describe("status bar", () => {
  it("shows the workers segment and the UTC clock", async () => {
    mockApi();
    mount(<StatusBar />);
    await waitFor(() => expect(document.getElementById("sb-workers")?.textContent).toMatch(/^WORKERS /));
    expect(document.getElementById("clock")?.textContent).toMatch(/UTC$/);
  });
});
