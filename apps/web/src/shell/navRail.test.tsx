/** The collapsible nav: the rail pref, the "[" key, folded sections and the flyout, against the whole shell. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { canBatcher } from "../api/can";
import { getPrefs, reloadPrefs, PREFS_KEY } from "../lib/prefs";
import { isTypingTarget, sectionTag } from "./navRail";

const me = {
  person: { id: "p-x", name: "Asha Raman", title: "Head", email: "a@x.dev", teams: [], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "asha", away: null },
  session: { id: "s1", person: "p-x", method: "sso", device: "d", ip: "1", started: 0, lastSeen: 0, revoked: false },
  csrf: "c",
  projects: [{ id: "payments", name: "Payments", key: "PAY", status: "active", halted: null, killed: null }],
  factory: { killed: null },
  config: { demoAccounts: false },
};
class FakeES { onopen = null; onerror = null; addEventListener() {} close() {} }

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeES);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    if (path === "/api/v1/can") return new Response(JSON.stringify({ results: (JSON.parse(String(init?.body)) as { checks: unknown[] }).checks.map(() => ({ allowed: true, reason: "", needs: "" })) }));
    if (path === "/api/v1/me") return new Response(JSON.stringify(me));
    if (path === "/api/v1/home") return new Response(JSON.stringify({ approvals: [{ wo: "WO-1", gate: "G3", title: "A", project: "payments" }], conversations: [] }));
    return new Response("{}", { status: 404 });
  }));
  window.location.hash = "#/home";
  try { localStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
  canBatcher.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const nav = async () => within(await screen.findByRole("navigation", { name: "Primary" }));

describe("collapsible nav", () => {
  it("the mark toggles the rail, sets aria-expanded and remembers the choice", async () => {
    render(<App />);
    const n = await nav();
    const toggle = await n.findByRole("button", { name: "Collapse navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect((await n.findByRole("button", { name: "Expand navigation" })).getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("side")?.classList.contains("rail")).toBe(true);
    expect(document.getElementById("app")?.classList.contains("rail")).toBe(true);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}").navRail).toBe(true);
    expect(getPrefs().navRail).toBe(true);
  });

  it("[ toggles the rail but is ignored while typing", async () => {
    render(<App />);
    await nav();
    fireEvent.keyDown(document.body, { key: "[" });
    await waitFor(() => expect(getPrefs().navRail).toBe(true));
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "[" });
    expect(getPrefs().navRail).toBe(true);
    fireEvent.keyDown(document.body, { key: "[", ctrlKey: true });
    expect(getPrefs().navRail).toBe(true);
    fireEvent.keyDown(document.body, { key: "[" });
    await waitFor(() => expect(getPrefs().navRail).toBe(false));
    expect(isTypingTarget(input)).toBe(true);
  });

  it("a section header folds its links (aria-expanded), keeps the current page, and is remembered", async () => {
    render(<App />);
    const n = await nav();
    const head = await n.findByRole("button", { name: /^Overview/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(n.getByRole("link", { name: /^Projects/ })).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(n.queryByRole("link", { name: /^Projects/ })).toBeNull();
    expect(n.getByRole("link", { name: /^Home/ }).getAttribute("aria-current")).toBe("page");
    expect(getPrefs().navCollapsed.Overview).toBe(true);
  });

  it("in the rail the folds are ignored (every link stays), the badge text stays in the link and a focus shows the flyout", async () => {
    render(<App />);
    const n = await nav();
    fireEvent.click(await n.findByRole("button", { name: /^Overview/ }));
    fireEvent.click(n.getByRole("button", { name: "Collapse navigation" }));
    expect(n.getByRole("link", { name: /^Projects/ })).toBeTruthy();
    const inbox = await n.findByRole("link", { name: /^Inbox/ });
    expect(inbox.querySelector(".cnt")?.textContent).toBe("1");
    fireEvent.focus(inbox);
    expect(document.getElementById("nav-fly")?.textContent).toContain("Inbox");
    fireEvent.keyDown(inbox, { key: "Escape" });
    expect(document.getElementById("nav-fly")).toBeNull();
  });

  it("section tags are short readable words", () => {
    expect(sectionTag("Overview")).toBe("Home");
    expect(sectionTag("Project")).toBe("Line");
    // T-35: readable words, not OV / AGT / CON
    expect(["Overview", "Project", "Agents", "Connect", "Govern", "Reference"].map(sectionTag).every((t) => t.length >= 4 && !/^(OV|AGT|CON|GOV|REF)$/.test(t))).toBe(true);
    expect(sectionTag("Odd")).toBe("Odd");
  });
});
