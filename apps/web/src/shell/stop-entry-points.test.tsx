import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, mount, resetApp } from "../views/floor/testkit";
import { PaletteDialog } from "./Palette";
import { StatusCluster } from "./StatusCluster";

/** Kill and restore live in the status-chip popover and the Ctrl K palette, for people who hold the right; Home carries neither. */
beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /Line control/ }));
};
const withApi = (denied: string[], meOver: Record<string, unknown> = {}) => {
  mockApi({ "GET /api/v1/policies": () => ({ body: [] }), "GET /api/v1/freezes": () => ({ body: [] }) }, { denied, me: meOver });
  mount(<StatusCluster />);
};

describe("status chip: Line control menu", () => {
  it("lists Halt line and Emergency stop, and opens the shared kill dialog", async () => {
    withApi([]);
    await open();
    expect(await screen.findByRole("menuitem", { name: /Halt line/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Emergency stop/ }));
    expect(await screen.findByText("Emergency stop the factory")).toBeTruthy();
  });

  it("locks the stop entries for a person who may not, rather than hiding the menu", async () => {
    withApi(["kill.factory", "restore.factory", "line.halt"]);
    await open();
    const stop = await screen.findByRole("menuitem", { name: /Emergency stop/ });
    await waitFor(() => expect(stop.getAttribute("aria-disabled")).toBe("true"));
  });

  it("when the factory is killed, the chip reads Stopped and the menu offers Restore factory", async () => {
    withApi([], { factory: { killed: { by: "p-omar", at: Date.now(), reason: "Leak", mode: "hold" } } });
    expect(await screen.findByText("Stopped")).toBeTruthy();
    await open();
    expect(await screen.findByRole("menuitem", { name: /Restore factory/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Emergency stop/ })).toBeNull();
  });
});

describe("Ctrl K palette", () => {
  const palette = () => mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
  const labels = (): string[] => Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent ?? "");

  it("lists Kill factory… and the project kill for people who may", async () => {
    mockApi();
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Command palette" }), { target: { value: "kill" } });
    await waitFor(() => expect(labels()).toContain("Kill factory…"));
    expect(labels().some((l) => /^Kill Payments Platform…$/.test(l))).toBe(true);
  });

  it("does not list kill or restore commands to people who may not", async () => {
    mockApi({}, { denied: ["kill.factory", "kill.project", "restore.factory", "restore.project"] });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Command palette" }), { target: { value: "kill" } });
    await waitFor(() => expect(document.querySelector("#palette-list")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(labels().filter((l) => /^(Kill|Restore)/.test(l))).toEqual([]);
  });

  it("lists Restore factory… while the factory is killed", async () => {
    mockApi({}, { me: { factory: { killed: { by: "p-omar", at: 1, reason: "Leak", mode: "hold" } } } });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Command palette" }), { target: { value: "restore" } });
    await waitFor(() => expect(labels()).toContain("Restore factory…"));
  });
});
