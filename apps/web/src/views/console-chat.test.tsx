import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConsoleRoute from "./console-chat";
import WorkspaceView from "./workspace";
import { updatePrefs } from "../lib/prefs";
import { mockApi, mount, resetApp } from "./floor/testkit";
import type { InboxItem } from "./workspace/api";
import { resetConsoleLocal } from "./console";

const now = Date.now();
const STATUS = { configured: true, vendor: "anthropic", model: "claude-test", models: [], proposals: [{ kind: "halt", tool: "propose_halt", right: "console.propose.halt", name: "Console: propose halt", does: "halt a project", allowed: true, reason: "", needs: "" }], canUse: true, actionsEnabled: true, retentionDays: 90, tools: [] };
const chat = (key: string, title: string, over: Partial<InboxItem> = {}): InboxItem => ({
  key, kind: "chat", scope: { kind: "factory", id: null, label: "Factory" }, project: null, title, agent: null, agentName: "Console", waitingOn: "nobody", unread: false, latest: null,
  updatedAt: now - 60_000, archived: null, pinned: false, mine: true, shared: false, owner: "p-asha", visibility: "private", spendUsd: null, ...over,
});
const INBOX = [chat("ct-1", "Which gates are slow?"), chat("ct-2", "Spend by project", { owner: "p-meera", mine: false, shared: true, scope: { kind: "project", id: "payments", label: "Payments Platform" }, project: "payments" })];
const thread = (id: string, title: string) => ({ id, title, pinned: ["WO-1042"], createdAt: now, updatedAt: now, expiresAt: now + 1e9, retentionDays: 90, owner: "p-asha", scope: { kind: "factory", id: null }, projectId: null, visibility: "private", status: "active", can: { post: true, manage: true }, members: [],
  messages: [{ id: `${id}-m1`, threadId: id, role: "user", text: "Which gates are slow?", at: now - 2000, data: {}, author: "p-asha" }, { id: `${id}-m2`, threadId: id, role: "assistant", text: "G5 is the slowest.", at: now - 1000, data: { mode: "model", cited: [{ type: "wo", id: "WO-1042" }] } }] });

/** The shared test kit answers JSON only; the console's answer is a server-sent stream. */
const streaming = (sse: string): Array<Record<string, unknown>> => {
  const inner = globalThis.fetch;
  const posts: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/v1/console/messages")) return inner(url, init);
    posts.push(JSON.parse(String(init?.body)));
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }));
  return posts;
};
const api = (extra: Record<string, (u: string, i?: RequestInit, b?: any) => any> = {}) => mockApi({
  "GET /api/v1/workspace/inbox": () => ({ body: { items: INBOX } }),
  "GET /api/v1/console/threads": () => ({ body: { items: [{ id: "ct-1", title: "Which gates are slow?", pinned: [], updatedAt: now - 60_000, expiresAt: now + 1e9, retentionDays: 90, count: 2 }], retentionDays: 90 } }),
  "GET /api/v1/console/threads/ct-1": () => ({ body: thread("ct-1", "Which gates are slow?") }),
  "GET /api/v1/console/status": () => ({ body: STATUS }),
  ...extra,
} as never);

beforeEach(() => { resetApp(); resetConsoleLocal(); updatePrefs({ scopeAll: false, project: "payments" }); Object.defineProperty(window, "scrollTo", { value: () => undefined, writable: true }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Console (#console): a general chat with Gantry", () => {
  it("says what it is in one line, with no hard-coded suggestions and no pinned work orders panel", async () => {
    window.location.hash = "#console/new";
    api();
    mount(<ConsoleRoute />);
    expect(await screen.findByText(/Ask Gantry anything about your factory/)).toBeTruthy();
    await screen.findByRole("button", { name: "New chat" });
    expect(screen.queryByText("What is blocked?")).toBeNull();
    expect(screen.queryByText("What waits on a person?")).toBeNull();
    expect(screen.queryByText("Spend this month")).toBeNull();
    expect(document.querySelector(".sugg")).toBeNull();
    expect(screen.queryByText("Pinned work orders")).toBeNull();
  });

  it("a chat opened from a link still renders when the inbox read has no items", async () => {
    window.location.hash = "#console/ct-1";
    api({ "GET /api/v1/workspace/inbox": () => ({ body: {} }) });
    mount(<ConsoleRoute />);
    expect(await screen.findByText("G5 is the slowest.")).toBeTruthy();
  });

  it("lists Recent and Shared with me with their project scope, and picking one puts it in the URL", async () => {
    window.location.hash = "#console/new";
    api();
    mount(<ConsoleRoute />);
    const nav = await screen.findByRole("navigation", { name: "Your chats" });
    await within(nav).findByText("Which gates are slow?");
    expect(within(nav).getByText("Recent")).toBeTruthy();
    expect(within(nav).getByText("Shared with me")).toBeTruthy();
    expect(within(nav).getByText(/Payments Platform/)).toBeTruthy();
    expect(within(nav).getByText(/All projects/)).toBeTruthy();
    fireEvent.click(within(nav).getByText("Which gates are slow?"));
    await waitFor(() => expect(window.location.hash).toBe("#console/ct-1"));
    expect(await screen.findByText("G5 is the slowest.")).toBeTruthy();
    // the work orders a chat names are chips inside it
    expect(document.querySelector(".msg-chips")?.textContent).toContain("WO-1042");
  });

  it("a chat opens from a link, with its own scroll area and the composer after it (pinned)", async () => {
    window.location.hash = "#console/ct-1";
    api();
    mount(<ConsoleRoute />);
    await screen.findByText("G5 is the slowest.");
    const log = document.getElementById("con-thread")!;
    const form = document.getElementById("con-form")!;
    expect(log.parentElement).toBe(form.parentElement);
    expect(log.nextElementSibling).toBe(form);
    expect(screen.getByLabelText("Project this chat asks about")).toBeTruthy();
  });

  it("New chat opens a blank chat at #console/new, and the first message creates it and puts its id in the URL", async () => {
    window.location.hash = "#console/ct-1";
    const sse = `event: thread\ndata: ${JSON.stringify({ threadId: "ct-9", messageId: "cm-1", created: true })}\n\nevent: done\ndata: ${JSON.stringify({ messageId: "cm-2", text: "Hello.", mode: "model", cited: [], proposals: [] })}\n\n`;
    api();
    const posts = streaming(sse);
    mount(<ConsoleRoute />);
    await screen.findByText("G5 is the slowest.");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(window.location.hash).toBe("#console/new"));
    await waitFor(() => expect(screen.queryByText("G5 is the slowest.")).toBeNull());
    fireEvent.change(document.getElementById("con-input")!, { target: { value: "Hi" } });
    fireEvent.submit(document.getElementById("con-form")!);
    await waitFor(() => expect(window.location.hash).toBe("#console/ct-9"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.threadId).toBeUndefined();
  });

  it("the project scope of a chat includes All projects and is what the question is sent with", async () => {
    window.location.hash = "#console/new";
    const sse = `event: done\ndata: ${JSON.stringify({ messageId: "cm-2", text: "ok", mode: "model", cited: [], proposals: [] })}\n\n`;
    api();
    const posts = streaming(sse);
    mount(<ConsoleRoute />);
    const sel = (await screen.findByLabelText("Project this chat asks about")) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toContain("All projects");
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.change(await screen.findByLabelText("Message the factory"), { target: { value: "anything" } });
    fireEvent.submit(document.getElementById("con-form")!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.project).toBeUndefined();
  });

  it("Settings open in place next to the header: the model, what the console may do with its permission codes, and the audit link", async () => {
    window.location.hash = "#console/ct-1";
    api();
    mount(<ConsoleRoute />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const dlg = await screen.findByRole("dialog", { name: "Console settings" });
    expect(await within(dlg).findByText("console.propose.halt")).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "Open in the audit log" })).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Open in the audit log" }));
    await waitFor(() => expect(window.location.hash).toBe("#audit/console"));
  });

  it("New work order keeps the submit form one click away at #console/submit", async () => {
    window.location.hash = "#console";
    api();
    mount(<ConsoleRoute />);
    fireEvent.click(await screen.findByRole("button", { name: "New work order" }));
    await waitFor(() => expect(window.location.hash).toBe("#console/submit"));
  });

  it("the old #workspace/chats and #workspace/new routes still open", async () => {
    window.location.hash = "#workspace/chats";
    api({ "GET /api/v1/workspace/inbox": () => ({ body: { items: [] } }) });
    mount(<WorkspaceView />);
    await waitFor(() => expect(document.getElementById("ws-new")).toBeTruthy());
    cleanup();
    window.location.hash = "#workspace/new";
    mount(<WorkspaceView />);
    await screen.findByLabelText("Message the factory");
  });
});
