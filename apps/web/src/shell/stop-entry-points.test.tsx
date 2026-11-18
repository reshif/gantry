import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, mount, resetApp } from "../views/floor/testkit";
import { PaletteDialog } from "./Palette";

/** Emergency stop and restore live in the Ctrl K palette (and Security), for people who hold the right; the status bar and Home carry neither. */
beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Ctrl K palette", () => {
  const palette = () => mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
  const labels = (): string[] => Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent ?? "");

  it("lists Kill factory… and the project kill for people who may", async () => {
    mockApi();
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "stop" } });
    await waitFor(() => expect(labels()).toContain("Emergency stop the factory…"));
    // the prototype's palette has no per-project stop or halt, and no Sign out action
    expect(labels().some((l) => /Payments Platform/.test(l) && /^(Halt|Emergency stop)/.test(l))).toBe(false);
    expect(labels()).not.toContain("Sign out");
  });

  it("does not list kill or restore commands to people who may not", async () => {
    mockApi({}, { denied: ["kill.factory", "kill.project", "restore.factory", "restore.project"] });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "stop" } });
    await waitFor(() => expect(document.querySelector("#palette-list")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(labels().filter((l) => /^(Emergency stop|Restore)/.test(l))).toEqual([]);
  });

  it("lists Restore factory… while the factory is killed", async () => {
    mockApi({}, { me: { factory: { killed: { by: "p-omar", at: 1, reason: "Leak", mode: "hold" } } } });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "restore" } });
    await waitFor(() => expect(labels()).toContain("Restore the factory…"));
  });
});
