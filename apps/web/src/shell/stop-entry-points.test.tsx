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
  fireEvent.click(await screen.findByRole("button", { name: /Show change windows and freezes/ }));
};
const withApi = (denied: string[], meOver: Record<string, unknown> = {}) => {
  mockApi({ "GET /api/v1/policies": () => ({ body: [] }), "GET /api/v1/freezes": () => ({ body: [] }) }, { denied, me: meOver });
  mount(<StatusCluster />);
};

describe("status chip popover", () => {
  it("offers Kill factory to a person who may, and opens the shared kill dialog", async () => {
    withApi([]);
    await open();
    const kill = await screen.findByRole("button", { name: "Kill factory…" });
    fireEvent.click(kill);
    expect(await screen.findByText("Kill the whole factory")).toBeTruthy();
  });

  it("offers nothing destructive to a person who may not (Auditor, Engineer)", async () => {
    withApi(["kill.factory", "restore.factory"]);
    await open();
    await screen.findByText("Release windows");
    await waitFor(() => expect(document.getElementById("sp-stop")).toBeNull());
    expect(screen.queryByRole("button", { name: /kill|restore/i })).toBeNull();
  });

  it("when the factory is killed, offers Restore with the approvals so far", async () => {
    withApi([], { factory: { killed: { by: "p-omar", at: Date.now(), reason: "Leak", mode: "hold", restoreApprovals: [{ by: "p-omar", at: Date.now() }] } } });
    await open();
    expect(await screen.findByText("1 restore approval so far.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve restore…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Kill factory/ })).toBeNull();
  });
});

describe("Ctrl K palette", () => {
  const palette = () => mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
  const labels = (): string[] => Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent ?? "");

  it("lists Kill factory… and the project kill for people who may", async () => {
    mockApi();
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "kill" } });
    await waitFor(() => expect(labels()).toContain("Kill factory…"));
    expect(labels().some((l) => /^Kill Payments Platform…$/.test(l))).toBe(true);
  });

  it("does not list kill or restore commands to people who may not", async () => {
    mockApi({}, { denied: ["kill.factory", "kill.project", "restore.factory", "restore.project"] });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "kill" } });
    await waitFor(() => expect(document.querySelector("#palette-list")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(labels().filter((l) => /^(Kill|Restore)/.test(l))).toEqual([]);
  });

  it("lists Restore factory… while the factory is killed", async () => {
    mockApi({}, { me: { factory: { killed: { by: "p-omar", at: 1, reason: "Leak", mode: "hold" } } } });
    palette();
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "restore" } });
    await waitFor(() => expect(labels()).toContain("Restore factory…"));
  });
});
