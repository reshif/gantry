import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hourly } from "../lib/eventText";
import { ROUTES } from "../lib/routes";
import { VIEWS } from "../views";
import { me as meRead, mockApi, mount, PAYMENTS, resetApp } from "../views/floor/testkit";
import { PaletteDialog } from "./Palette";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";

beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("sub-page routes", () => {
  it("Traveler and Dossier are project routes with their own view, as in the prototype", () => {
    for (const id of ["traveler", "dossier"]) {
      const r = ROUTES.find((x) => x.id === id);
      expect(r?.project).toBe(true);
      expect(r?.nav).toBe(false);
      expect(VIEWS[id]).toBeTruthy();
    }
  });
});

describe("throughput", () => {
  it("the status bar and the Home chart read the same hourly buckets", () => {
    const now = Date.now();
    const ev = [{ at: now - 10 * 60_000, type: "wo.enter" }, { at: now - 70 * 60_000, type: "wo.enter" }, { at: now - 30 * 3_600_000, type: "wo.enter" }, { at: now, type: "halt" }];
    const b = hourly(ev);
    expect(b).toHaveLength(24);
    expect(b[23]).toBe(1);
    expect(b[22]).toBe(1);
    expect(b.reduce((a, c) => a + c, 0)).toBe(2);
  });
  it("the status bar shows entries per hour from the activity feed", async () => {
    mockApi({ "GET /api/v1/activity": () => ({ body: [6, 7, 8, 9, 10, 11].map((n, i) => ({ id: n, at: Date.now() - (i * 60 + 5) * 60_000, type: "wo.enter", wo: `WO-${n}`, station: "build", project: "payments" })) }) });
    mount(<StatusBar />);
    await waitFor(() => expect(document.getElementById("sb-throughput")?.textContent).toBe("THROUGHPUT 1.0/h"));
  });
});

describe("palette work orders", () => {
  it("lists open work first, in id order, then shipped work", async () => {
    const wo = (id: string, state: string) => ({ id, title: `T ${id}`, state, project: "payments", repo: "r" });
    mockApi({ "GET /api/v1/projects/payments/work-orders": () => ({ body: [wo("WO-990", "done"), wo("WO-1002", "running"), wo("WO-1001", "running")] }) });
    mount(<PaletteDialog projectId="payments" onClose={() => undefined} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Search commands" }), { target: { value: "·" } });
    await waitFor(() => expect(document.querySelectorAll("#palette-list .pal-label").length).toBe(3));
    expect(Array.from(document.querySelectorAll("#palette-list .pal-label")).map((e) => e.textContent)).toEqual(["WO-1001 · T WO-1001", "WO-1002 · T WO-1002", "WO-990 · T WO-990"]);
  });
});

describe("user menu", () => {
  it("offers Switch persona (demo) with the prototype's four people when the stack runs demo accounts", async () => {
    const list = [["p-asha", "Asha Raman", "asha", "factory admin"], ["p-meera", "Meera Iyer", "meera", "line lead"], ["p-tomas", "Tomás Ferreira", "tomas", "engineer"], ["p-sam", "Sam Whitfield", "sam", "auditor"]].map(([id, name, e, role]) => ({ id, name, email: `${e}@acme.dev`, role, note: "" }));
    const me = meRead({ config: { demoAccounts: true, demoAccountList: list } });
    mockApi({ "GET /api/v1/me": () => ({ body: me }) });
    mount(<TopBar me={me as never} crumb={[]} project={PAYMENTS as never} current="home" navOpen={false} onOpenNav={() => undefined} onOpenPalette={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Switch persona (demo)");
    for (const n of ["Asha Raman", "Meera Iyer", "Tomás Ferreira", "Sam Whitfield"]) expect(menu.textContent).toContain(n);
    expect(menu.textContent).toContain("factory admin");
    expect(menu.textContent).toContain("Sign out");
  });
  it("a persona the directory cannot resolve by id still shows initials, never ?", async () => {
    const list = [{ id: "idp-zed", name: "Zed Quill", email: "zed@acme.dev", role: "engineer", note: "" }];
    const me = meRead({ config: { demoAccounts: true, demoAccountList: list } });
    mockApi({ "GET /api/v1/me": () => ({ body: me }) });
    mount(<TopBar me={me as never} crumb={[]} project={PAYMENTS as never} current="home" navOpen={false} onOpenNav={() => undefined} onOpenPalette={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("ZQ");
  });
  it("says 'Now viewing as <name>' once the session is that person after a persona switch", async () => {
    const me = meRead({ config: { demoAccounts: true } });
    window.sessionStorage.setItem("gantry.personaSwitch", me.person!.name);
    mockApi({ "GET /api/v1/me": () => ({ body: me }) });
    mount(<TopBar me={me as never} crumb={[]} project={PAYMENTS as never} current="home" navOpen={false} onOpenNav={() => undefined} onOpenPalette={() => undefined} />);
    expect(await screen.findByText(`Now viewing as ${me.person!.name}`)).toBeTruthy();
    expect(window.sessionStorage.getItem("gantry.personaSwitch")).toBeNull();
  });
  it("hides the persona switch where demo accounts are off", async () => {
    const me = meRead({ config: { demoAccounts: false } });
    mockApi({ "GET /api/v1/me": () => ({ body: me }) });
    mount(<TopBar me={me as never} crumb={[]} project={PAYMENTS as never} current="home" navOpen={false} onOpenNav={() => undefined} onOpenPalette={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    expect((await screen.findByRole("menu")).textContent).not.toContain("Switch persona");
  });
});

