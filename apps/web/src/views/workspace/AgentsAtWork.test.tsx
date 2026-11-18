import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updatePrefs } from "../../lib/prefs";
import { AgentsAtWork } from "./AgentsAtWork";
import { mockApi, mount, resetApp } from "../floor/testkit";

beforeEach(() => {
  resetApp();
  window.history.replaceState(null, "", "/");
  updatePrefs({ scopeAll: false, project: "payments" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agents at work (prototype workspace)", () => {
  it("has the prototype subtitle, URL filters with a Clear, links to the record, Talk on every card and a Stop run", async () => {
    mockApi();
    mount(<AgentsAtWork />);
    expect(await screen.findByText(/open a conversation or stop a run/)).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll(".ws-card").length).toBeGreaterThan(5));
    const cards = Array.from(document.querySelectorAll(".ws-card"));
    for (const c of cards) expect(c.querySelector("[id^=ws-talk-]")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(document.querySelector(".ws-card a.mono")?.getAttribute("href")).toMatch(/record\/WO-/);
    expect(document.querySelector("[id^=ws-stop-]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    fireEvent.change(document.getElementById("ws-act")!, { target: { value: "idle" } });
    await waitFor(() => expect(window.location.search).toContain("st=idle"));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(window.location.search).not.toContain("st="));
  });

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

  it("matches the prototype: no Conversations action, Cost per hour tile, and Talk opens that work order's conversation", async () => {
    mockApi();
    mount(<AgentsAtWork />);
    await waitFor(() => expect(document.querySelectorAll(".ws-card").length).toBeGreaterThan(5));
    expect(document.getElementById("ws-open-chats")).toBeNull();
    expect(screen.getByText("Cost per hour")).toBeTruthy();
    expect(screen.queryByText("Cost so far")).toBeNull();
    expect(screen.getByText("Tokens in flight").closest(".stat")?.textContent).toMatch(/last hour/);
    expect(document.querySelector(".ws-card .tok-stream")?.children.length).toBe(3);
    // the prototype's link shape: the conversations route with ?c=<thread>
    expect([...document.querySelectorAll("[id^=ws-talk-]")].map((a) => a.getAttribute("href"))).toContainEqual(expect.stringMatching(/^#\/p\/payments\/conversations\?c=WO-/));
    fireEvent.click(document.querySelector("[id^=ws-talk-]")!);
    await waitFor(() => expect(window.location.hash).toMatch(/conversations/));
  });

  it("a search that matches nothing keeps the totals: Agents busy reads 0 / <all agents>", async () => {
    window.history.replaceState(null, "", "/?q=zzzzzz");
    mockApi();
    mount(<AgentsAtWork />);
    const tile = await screen.findByText("Agents busy");
    await waitFor(() => expect(tile.closest(".stat")?.textContent).toMatch(/0 \/ [6-9]|0 \/ \d\d/));
    expect(document.querySelectorAll(".ws-card").length).toBe(0);
  });

  it("?state=loading shows the shared loading skeleton", async () => {
    window.history.replaceState(null, "", "/?state=loading");
    mockApi();
    mount(<AgentsAtWork />);
    expect(await screen.findByLabelText("Loading")).toBeTruthy();
    expect(document.querySelectorAll(".ws-card").length).toBe(0);
  });

  it("says the floor is not visible on a 403, instead of showing no agents", async () => {
    mockApi({ "GET /api/v1/projects/payments/floor": () => ({ status: 403, body: { ok: false, msg: "Needs a role on this project." } }) });
    mount(<AgentsAtWork />);
    expect(await screen.findByText("Not visible to you")).toBeTruthy();
  });
});
