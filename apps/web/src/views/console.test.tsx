import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "@gantry/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canBatcher } from "../api/can";
import { bindQueryClient } from "../api/keys";
import { setCsrfToken } from "../api/client";
import { OverlayProvider } from "../ui/Overlay";
import ConsoleView, { resetConsoleLocal } from "./console";
import { ExplainDenial } from "./console/ExplainDenial";
import { SseReader } from "./console/api";
import { Markdown } from "./console/Markdown";
import { plan } from "./console/slash";

type Out = { status?: number; body: unknown } | { sse: string; status?: number } | { open: (signal: AbortSignal | undefined) => ReadableStream<Uint8Array> };
type Handler = (url: string, init?: RequestInit, body?: any) => Out;
interface Call { method: string; path: string; body: any; headers: Record<string, string>; query: URLSearchParams }

const person = (id: string, name: string, o: object = {}) => ({ id, name, title: "Engineer", email: `${id}@acme.dev`, teams: ["payments"], roles: [{ role: "factory_admin", scope: "factory" }], status: "active", oncall: false, github: "", away: null, version: 2, ...o });
const ASHA = person("p-asha", "Asha Raman");
const project = (id: string, name: string, o: object = {}) => ({ id, name, key: id.toUpperCase(), status: "active", teams: [], owner: "p-asha", template: "t", regulated: false, desc: "", approvers: {}, notifications: [], mcp: [], budget: { monthly: 1000, mtd: 0, alertAt: 0.8 }, created: 0, halted: null, killed: null, overlay: "", version: 1, flow: { order: [], bays: [], gates: {}, classes: [], slots: 2 }, ...o });
const PAYMENTS = project("payments", "Payments Platform");
const RISK = project("risk", "Risk and Compliance");

const STATUS = { configured: true, vendor: "anthropic", model: "claude-test-1", actionsEnabled: false, version: 0, retentionDays: 90, tools: [] };
const KINDS: Array<[string, string, string]> = [["submit", "propose_submit_work_order", "submit a work order"], ["approve_gate", "propose_approve_gate", "approve a gate"], ["halt", "propose_halt", "halt a repo line or project"], ["kill", "propose_kill", "kill a work order, project or the factory"]];
const rights = (allowed: (k: string) => boolean) => KINDS.map(([kind, tool, does]) => ({ kind, tool, does, right: `console.propose.${kind}`, name: `Console: propose ${kind}`, allowed: allowed(kind), reason: allowed(kind) ? "Role matrix: Factory Admin on the factory may do it." : "No role held includes it.", needs: allowed(kind) ? "" : `Ask a Factory Admin to give you 'Console: propose ${kind}'.` }));
const NO_MODEL = { configured: false, code: "no_model_configured", reason: "No model is configured, so the console cannot answer questions yet. Ask a Factory Admin to connect a model vendor and set a default model in Models.", actionsEnabled: false, version: 0, retentionDays: 90, tools: [] };

const sse = (...evs: Array<[string, unknown]>): string => evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const proposal = (o: object = {}) => ({
  id: "PROP-1", kind: "halt", title: "Pull the andon cord on Payments Platform", summary: "duplicate refunds", steps: ["A soft, resumable pause"], status: "pending", needsReason: 4, phrase: null, danger: false, entities: [{ type: "project", id: "payments", label: "Payments Platform" }],
  call: { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "halt", reason: "duplicate refunds", via: "console" }, idempotent: true },
  perm: { action: "line.halt", project: "payments" }, check: { allowed: true, reason: "Role matrix: Factory Admin may halt.", needs: "" }, ...o,
});

function me() {
  return { person: ASHA, session: { id: "s1", person: "p-asha", method: "sso", device: "Chrome", ip: "1", started: 0, lastSeen: 0, revoked: false }, csrf: "c", org: { id: "acme", name: "Acme", plant: "P", tz: "IST" }, projects: [PAYMENTS, RISK], factory: { killed: null }, config: {} };
}

function setup(extra: Record<string, Handler> = {}, denied: string[] = []) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "GET /api/v1/me": () => ({ body: me() }),
    "GET /api/v1/people": () => ({ body: [ASHA] }),
    "GET /api/v1/agents": () => ({ body: [] }),
    "GET /api/v1/projects": () => ({ body: [PAYMENTS, RISK] }),
    "GET /api/v1/catalog": () => ({ body: DEFAULT_CATALOG }),
    "GET /api/v1/projects/payments/work-orders": () => ({ body: { items: [{ id: "WO-1042", state: "waiting", bay: null }], next: null, total: 1 } }),
    "GET /api/v1/audit": () => ({ body: { items: [{ id: 5, at: Date.now(), action: "halt", target: "Payments Platform", outcome: "ok" }], next: null } }),
    "GET /api/v1/console/status": () => ({ body: STATUS }),
    "GET /api/v1/console/threads": () => ({ body: { items: [], retentionDays: 90 } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const hdr: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdr[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: hdr, query: u.searchParams });
    if (u.pathname === "/api/v1/can") {
      const checks = (body as { checks: Array<{ action: string }> }).checks;
      return new Response(JSON.stringify({ results: checks.map((c) => (denied.includes(c.action) ? { allowed: false, reason: `No role holds ${c.action}.`, needs: "Needs Factory Admin", rule: { id: "MATRIX" } } : { allowed: true, reason: "", needs: "" })) }));
    }
    const h = base[`${method} ${u.pathname}`] ?? Object.entries(base).find(([k]) => { const [m, p] = k.split(" "); return m === method && p!.endsWith("/*") && u.pathname.startsWith(p!.slice(0, -1)); })?.[1];
    const r = h ? h(url, init, body) : { status: 404, body: { ok: false, msg: `no mock ${method} ${u.pathname}` } };
    if ("sse" in r) return new Response(r.sse, { status: r.status ?? 200, headers: { "content-type": "text/event-stream" } });
    if ("open" in r) return new Response(r.open(init?.signal ?? undefined), { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
  return calls;
}

const byId = (id: string) => waitFor(() => { const e = document.getElementById(id); if (!e) throw new Error(`no #${id}`); return e; });
function mount(aux?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  const r = render(<QueryClientProvider client={qc}><OverlayProvider><ConsoleView /></OverlayProvider></QueryClientProvider>);
  if (aux) void ask(aux); // /settings or /chats opens the panel the prototype page does not carry
  return r;
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const firstOf = (sel: string) => waitFor(() => { const e = document.querySelector<HTMLElement>(sel); if (!e) throw new Error(`no ${sel}`); return e; });
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
async function ask(text: string) { type(await byId("con-input"), text); fireEvent.submit(document.getElementById("con-form")!); }
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  setCsrfToken("c");
  canBatcher.clear();
  window.location.hash = "";
  resetConsoleLocal();
  Object.defineProperty(window, "scrollTo", { value: () => undefined, writable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Console (legacy console.js on the real API)", () => {
  describe("no model", () => {
    it("says so in the badge and the mode line, and the first message offers slash commands only", async () => {
      setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
      mount("/settings");
      const badge = await byId("con-mode");
      await waitFor(() => expect(badge.textContent).toBe("No model"));
      expect(badge.className).toContain("ask-absent");
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("No model is configured");
      expect(text()).not.toContain("is answered by");
    });

    it("a question is answered at once from live state, or with what can be asked, never by a model that is not there", async () => {
      const calls = setup({
        "GET /api/v1/console/status": () => ({ body: NO_MODEL }),
        "POST /api/v1/console/messages": () => ({ sse: sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["unavailable", { code: "no_model_configured", msg: NO_MODEL.reason, messageId: "cm-2" }], ["done", { messageId: "cm-2", text: NO_MODEL.reason, mode: "none", cited: [], proposals: [] }]) }),
        "GET /api/v1/console/threads/ct-1": () => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-1", role: "user", text: "What is waiting on me?", at: Date.now() - 10, data: {} }, { id: "cm-2", threadId: "ct-1", role: "system", text: NO_MODEL.reason, at: Date.now(), data: { kind: "no_model" } }] } }),
      });
      mount("/settings");
      await ask("What is waiting on me?");
      // with no model the page answers at once from live state and calls nothing
      await waitFor(() => expect(text()).toContain("Nothing is waiting on a person."));
      await ask("tell me a joke");
      await waitFor(() => expect(text()).toContain("I can answer questions about work orders"));
      await ask("status of WO-9999");
      await waitFor(() => expect(text()).toContain("I cannot find WO-9999."));
      expect(calls.some((c) => c.path === "/api/v1/console/messages")).toBe(false);
    });
  });

  describe("the model's answer", () => {
    it("streams text in as it arrives, then shows the saved message with entity chips and its mode", async () => {
      const calls = setup({
        "POST /api/v1/console/messages": () => ({ sse: sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["text", { delta: "WO-1042 is " }], ["tool", { name: "get_work_order", ok: true }], ["text", { delta: "waiting at G2." }],
          ["done", { messageId: "cm-2", text: "WO-1042 is waiting at G2.", mode: "model", model: "claude-test-1", cited: [{ type: "wo", id: "WO-1042", project: "payments" }], proposals: [] }]) }),
        "GET /api/v1/console/threads/ct-1": () => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [
          { id: "cm-1", threadId: "ct-1", role: "user", text: "Why is WO-1042 stuck?", at: Date.now() - 10, data: {} },
          { id: "cm-2", threadId: "ct-1", role: "assistant", text: "WO-1042 is waiting at G2.", at: Date.now(), data: { mode: "model", cited: [{ type: "wo", id: "WO-1042", project: "payments" }], proposals: [], tools: ["get_work_order"] } }] } }),
      });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-mode")!.textContent).toBe("claude-test-1"));
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("claude-test-1");
      // T-3: the reason is the factory switch and who can flip it, never a made-up "read-only for you"
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("switched off for this factory");
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("A Factory Admin can switch them on");
      expect(document.getElementById("con-mode-reason")!.textContent).not.toContain("read-only");
      await ask("Why is WO-1042 stuck?");
      await waitFor(() => expect(text()).toContain("WO-1042 is waiting at G2."));
      // T-14: the model is named once, in the header chip, not under every reply
      expect(document.querySelector(".msg-mode.is-model")).toBeNull();
      expect(text()).toContain("WO-1042 is waiting at G2.");
      const chip = document.querySelector(".msg-chips .entity-chip[data-entity='wo:WO-1042']");
      expect(chip).toBeTruthy();
      expect(document.querySelectorAll(".msg-user").length).toBe(1);
      expect(calls.filter((c) => c.path === "/api/v1/console/messages")).toHaveLength(1);
    });

    it("Stop ends the stream; the person keeps what was said", async () => {
      const enc = new TextEncoder();
      let aborted = false;
      setup({
        "POST /api/v1/console/messages": () => ({
          open: (signal) => new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["text", { delta: "Looking at the gates" }])));
              signal?.addEventListener("abort", () => { aborted = true; c.error(new DOMException("aborted", "AbortError")); });
            },
          }),
        }),
        "GET /api/v1/console/threads/ct-1": () => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-1", role: "user", text: "q", at: 1, data: {} }, { id: "cm-2", threadId: "ct-1", role: "assistant", text: "Looking at the gates", at: 2, data: { mode: "model", stopped: true } }] } }),
      });
      mount("/settings");
      await ask("Look at the gates");
      await waitFor(() => expect(text()).toContain("Looking at the gates"));
      expect(document.getElementById("con-send")!.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(await byId("con-stop"));
      await waitFor(() => expect(aborted).toBe(true));
      await waitFor(() => expect(document.querySelector(".msg-mode.is-model")?.textContent).toContain("stopped"));
      expect(document.getElementById("con-stop")).toBeNull();
    });

    it("on the Console page a send the model cannot answer gets the prototype's help line", async () => {
      setup({ "POST /api/v1/console/messages": () => ({ status: 404, body: { ok: false, msg: "No such conversation." } }) });
      mount("/settings");
      await ask("hello");
      await waitFor(() => expect(text()).toContain("I can answer questions about work orders"));
    });
  });

  describe("slash commands run the tools directly, with no model", () => {
    it("/projects reads list_projects and draws the table", async () => {
      const calls = setup({
        "GET /api/v1/console/status": () => ({ body: NO_MODEL }),
        "POST /api/v1/console/tools/*": (_u, _i, _b) => ({ body: { ok: true, tool: "list_projects", result: [{ id: "payments", name: "Payments Platform", key: "PAY", status: "active", halted: null, killed: null, inFlight: 3, waitingAtGates: 1, inBays: 0, health: "Healthy" }], proposals: [], cited: [] } }),
      });
      mount();
      await ask("/projects");
      await waitFor(() => expect(document.querySelector(".ccard table")).toBeTruthy());
      const t = calls.find((c) => c.path === "/api/v1/console/tools/list_projects")!;
      expect(t.body).toEqual({ input: {} });
      expect(document.querySelector(".ccard tbody")!.textContent).toContain("Payments Platform");
      expect(document.querySelector(".msg-mode.is-slash")!.textContent).toBe("Slash command · live data");
      expect(calls.some((c) => c.path === "/api/v1/console/messages")).toBe(false);
    });

    it("/who-can parses the action, project and the moment, and shows who may", async () => {
      const calls = setup({
        "POST /api/v1/console/tools/who_can": () => ({ body: { ok: true, tool: "who_can", result: { action: "release", name: "Release", scope: "project", project: "payments", at: new Date().toISOString(), allowed: 1, denied: 1, people: [{ person: "Asha Raman", id: "p-asha", allowed: true, reason: "Role matrix.", rule: "MATRIX" }, { person: "Tomas", id: "p-tomas", allowed: false, reason: "No role.", rule: "MATRIX" }] }, proposals: [], cited: [] } }),
      });
      mount();
      await ask("/who-can release payments friday 22:00");
      await waitFor(() => expect(document.querySelector(".decision.is-allowed")).toBeTruthy());
      const t = calls.find((c) => c.path === "/api/v1/console/tools/who_can")!;
      expect(t.body.input).toMatchObject({ action: "release", project: "payments" });
      expect(typeof t.body.input.at).toBe("number");
      expect(document.querySelector(".decision-v")!.textContent).toContain("1 allowed");
      expect(document.querySelector(".who-denied summary")!.textContent).toBe("1 denied");
    });

    it("/why shows the record's bullets, an Approve button only when actions are on, and can pin", async () => {
      const wo = { id: "WO-1042", title: "<untrusted>Add refund keys</untrusted>", project: "payments", state: "waiting", station: "spec", bay: null, createdAt: Date.now() - 3600_000, gates: [{ gate: "G2", status: "waiting", approvals: [{ by: "p-meera" }] }], stop: null };
      setup({ "POST /api/v1/console/tools/get_work_order": () => ({ body: { ok: true, tool: "get_work_order", result: wo, proposals: [], cited: [{ type: "wo", id: "WO-1042" }] } }) });
      mount();
      await ask("/why WO-1042");
      await waitFor(() => expect(document.querySelector(".ccard .bullets")).toBeTruthy());
      expect(text()).toContain("Add refund keys");
      expect(text()).not.toContain("<untrusted>");
      expect(document.querySelector(".ccard .bullets")!.textContent).toContain("Waiting at G2: 1 approval so far.");
      expect(document.querySelector("[id^='con-ex-appr-']")).toBeNull();
    });

    it("unknown or incomplete commands answer with help, and /help lists the commands", async () => {
      setup();
      mount();
      await ask("/nope");
      await waitFor(() => expect(text()).toContain("I do not know /nope"));
      await ask("/help");
      await waitFor(() => expect(document.querySelectorAll(".slash-help li").length).toBeGreaterThan(15));
      fireEvent.click(document.querySelector(".slash-help .linkish")!);
      await waitFor(() => expect((document.getElementById("con-input") as HTMLTextAreaElement).value).toBe("/help"));
    });

    it("typing / opens the command menu; Tab completes", async () => {
      setup();
      mount();
      const input = await byId("con-input");
      type(input, "/who");
      await waitFor(() => expect(document.querySelectorAll("#con-slash li").length).toBe(1));
      fireEvent.keyDown(input, { key: "Tab" });
      await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("/who-can "));
    });
  });

  describe("confirm cards (actions on)", () => {
    const ON = { "GET /api/v1/console/status": () => ({ body: { ...STATUS, actionsEnabled: true, canUse: true, isFactoryAdmin: true, proposals: rights(() => true) } }) };
    const tool = (name: string, p: object) => ({ [`POST /api/v1/console/tools/${name}`]: () => ({ body: { ok: true, tool: name, result: { proposed: "PROP-1" }, proposals: [p], cited: [] } }) });

    it("a halt asks for a reason, then calls the ordinary endpoint with via console and an Idempotency-Key", async () => {
      const calls = setup({ ...ON, ...tool("propose_halt", proposal()), "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform halted." } }) });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-rights")).toBeTruthy());
      await ask("/halt payments duplicate refunds");
      const ok = await firstOf("[id^='con-cf-ok-']");
      expect(calls.find((c) => c.path === "/api/v1/console/tools/propose_halt")!.body.input).toEqual({ scope: "project", id: "payments", reason: "duplicate refunds" });
      expect(writes(calls).filter((c) => c.path === "/api/v1/stops")).toHaveLength(0); // nothing ran
      const reason = document.querySelector<HTMLInputElement>("[id^='con-cf-reason-']")!;
      expect(reason.value).toBe("duplicate refunds");
      type(reason, "dup");
      fireEvent.click(ok);
      await waitFor(() => expect(document.querySelector(".con-cf-fields + .form-err, .form-err")!.textContent).toContain("at least 4 characters"));
      expect(writes(calls).filter((c) => c.path === "/api/v1/stops")).toHaveLength(0);
      type(reason, "duplicate refunds seen");
      fireEvent.click(ok);
      await waitFor(() => expect(document.querySelector(".ccard-confirm.is-done")).toBeTruthy());
      const post = calls.find((c) => c.path === "/api/v1/stops")!;
      expect(post.body).toEqual({ scope: "project", id: "payments", mode: "halt", reason: "duplicate refunds seen", via: "console" });
      expect(post.headers["idempotency-key"]).toBeTruthy();
      expect(text()).toContain("Payments Platform halted.");
      expect(document.querySelector("[id^='con-cf-ok-']")).toBeNull();
    });

    it("a kill needs the typed phrase and carries the in-flight choice", async () => {
      const calls = setup({ ...ON, ...tool("propose_kill", proposal({ kind: "kill", title: "Kill Payments Platform", phrase: "Payments Platform", danger: true, call: { method: "POST", path: "/api/v1/stops", body: { scope: "project", id: "payments", mode: "kill", reason: "bad deploy", inFlight: "hold", confirmText: "", via: "console" }, idempotent: true }, perm: { action: "kill.project", project: "payments" } })), "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Killed." } }) });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-rights")).toBeTruthy());
      await ask("/kill payments bad deploy");
      const card = await waitFor(() => { const c = document.querySelector<HTMLElement>(".ccard-confirm.is-danger"); if (!c) throw new Error("no card"); return c; });
      const ok = card.querySelector<HTMLElement>("[id^='con-cf-ok-']")!;
      expect(ok.textContent).toBe("Kill Payments Platform");
      fireEvent.click(ok);
      await waitFor(() => expect(card.querySelector(".form-err")!.textContent).toBe("Type Payments Platform exactly to confirm."));
      expect(calls.some((c) => c.path === "/api/v1/stops")).toBe(false);
      fireEvent.click(card.querySelector("input[value='cancel']")!);
      type(card.querySelector<HTMLInputElement>("[id^='con-cf-confirm-']")!, "Payments Platform");
      fireEvent.click(ok);
      await waitFor(() => expect(card.classList.contains("is-done")).toBe(true));
      expect(calls.find((c) => c.path === "/api/v1/stops")!.body).toEqual({ scope: "project", id: "payments", mode: "kill", reason: "bad deploy", inFlight: "cancel", confirmText: "Payments Platform", via: "console" });
    });

    it("a card the decision point refuses shows why, cannot be confirmed, and can be explained", async () => {
      const calls = setup({
        ...ON, ...tool("propose_halt", proposal({ check: { allowed: false, reason: "Only a Line Lead may halt this line.", needs: "Needs Line Lead", rule: "MATRIX" } })),
        "POST /api/v1/console/explain": () => ({ body: { ok: true, mode: "trace", explanation: null, note: "No model is configured, so this is the policy engine's own trace.", person: "Asha", action: "line.halt (Halt)", decision: { allowed: false, reason: "x", rule: { id: "MATRIX" }, needs: "" }, trace: ["Roles in scope: none.", "Deciding rule: MATRIX Role matrix."] } }),
      });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-rights")).toBeTruthy());
      await ask("/halt payments dup");
      const perm = await waitFor(() => { const e = document.querySelector(".perm.neg"); if (!e) throw new Error("no perm"); return e; });
      expect(perm.textContent).toContain("You can't do this: Needs Line Lead. Only a Line Lead may halt this line.");
      const ok = document.querySelector<HTMLElement>("[id^='con-cf-ok-']")!;
      expect(ok.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(ok);
      expect(writes(calls).filter((c) => c.path === "/api/v1/stops")).toHaveLength(0);
      fireEvent.click(document.querySelector<HTMLElement>("[id^='con-cf-explain-']:not([id$='-out']):not([id$='-stop'])")!);
      await waitFor(() => expect(document.querySelector(".explain-text")!.textContent).toBe("Roles in scope: none. Deciding rule: MATRIX Role matrix."));
      expect(document.querySelector(".explain-mode")!.textContent).toContain("No model is configured");
      expect(calls.find((c) => c.path === "/api/v1/console/explain")!.body).toEqual({ action: "line.halt", project: "payments" });
    });

    it("a proposal from the model's answer is saved on its message when confirmed or dismissed", async () => {
      const calls = setup({
        ...ON,
        "POST /api/v1/console/messages": () => ({ sse: sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["text", { delta: "Proposed." }], ["proposal", { messageId: "cm-2", proposal: proposal() }], ["done", { messageId: "cm-2", text: "Proposed.", mode: "model", model: "claude-test-1", cited: [], proposals: [proposal()] }]) }),
        "GET /api/v1/console/threads/ct-1": () => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-1", role: "user", text: "halt payments", at: 1, data: {} }, { id: "cm-2", threadId: "ct-1", role: "assistant", text: "Proposed.", at: 2, data: { mode: "model", proposals: [proposal()] } }] } }),
        "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Halted." } }),
        "PUT /api/v1/console/messages/cm-2/proposals/PROP-1": () => ({ body: { ok: true, msg: "Saved." } }),
      });
      mount("/settings");
      await ask("halt payments, duplicate refunds");
      const ok = await waitFor(() => { const e = document.querySelector<HTMLElement>("[id^='con-cf-ok-']"); if (!e) throw new Error("no card"); return e; });
      fireEvent.click(ok);
      await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/console/messages/cm-2/proposals/PROP-1")).toBe(true));
      expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/PROP-1"))!.body).toEqual({ status: "done", result: "Halted." });
    });

    it("a refusal from the endpoint ends the card as failed and says why", async () => {
      setup({ ...ON, ...tool("propose_halt", proposal()), "POST /api/v1/stops": () => ({ status: 403, body: { ok: false, msg: "Payments Platform is halted already." } }) });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-rights")).toBeTruthy());
      await ask("/halt payments dup refunds");
      fireEvent.click(await firstOf("[id^='con-cf-ok-']"));
      await waitFor(() => expect(document.querySelector(".ccard-confirm.is-failed")).toBeTruthy());
      expect(text()).toContain("Payments Platform is halted already.");
    });
  });

  describe("context panel and settings", () => {
    it("lists what the person can do in the current project, with reasons for what they cannot", async () => {
      setup({}, ["kill.factory"]);
      mount("/settings");
      const caps = await waitFor(() => { const c = document.querySelector(".caps"); if (!c || !c.querySelector("li.no")) throw new Error("not yet"); return c; });
      const no = caps.querySelector("li.no")!;
      expect(no.textContent).toContain("Kill the factory");
      expect(no.getAttribute("data-tip")).toBe("No role holds kill.factory.");
      expect(caps.querySelectorAll("li.ok").length).toBe(9);
      expect(document.querySelector(".mini-log")!.textContent).toContain("Payments Platform");
    });

    it("the panel lists what the console can do for you with a check or lock and the reason; no global toggle; admins get the manage link", async () => {
      setup({ "GET /api/v1/console/status": () => ({ body: { ...STATUS, actionsEnabled: true, canUse: true, isFactoryAdmin: true, proposals: rights((k) => k !== "kill") } }) });
      const r = mount("/settings");
      await waitFor(() => expect(document.getElementById("con-right-halt")).toBeTruthy());
      expect(document.getElementById("con-actions")).toBeNull();
      expect(document.getElementById("con-right-halt")!.className).toBe("ok");
      const kill = document.getElementById("con-right-kill")!;
      expect(kill.className).toBe("no");
      expect(kill.getAttribute("data-tip")).toBe("No role held includes it.");
      expect(kill.textContent).toContain("Ask a Factory Admin to give you 'Console: propose kill'");
      expect(document.getElementById("con-manage-perms")).toBeTruthy();
      r.unmount();
      cleanup();
      canBatcher.clear();
      // An Engineer: nothing allowed, read-only message, no admin link.
      setup({ "GET /api/v1/console/status": () => ({ body: { ...STATUS, actionsEnabled: false, canUse: true, isFactoryAdmin: false, proposals: rights(() => false) } }) });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-readonly")).toBeTruthy());
      expect(document.getElementById("con-readonly")!.textContent).toContain("no console right to propose changes is granted");
      expect(document.getElementById("con-readonly")!.textContent).not.toContain("read-only");
      expect(document.querySelectorAll("#con-rights li.ok").length).toBe(0);
      expect(document.getElementById("con-manage-perms")).toBeNull();
    });

    it("a slash action the person has no console right for says which right is missing and calls nothing", async () => {
      const calls = setup({ "GET /api/v1/console/status": () => ({ body: { ...STATUS, actionsEnabled: false, canUse: true, proposals: rights(() => false) } }) });
      mount("/settings");
      await waitFor(() => expect(document.getElementById("con-right-halt")).toBeTruthy());
      await ask("/halt payments duplicate refunds");
      await waitFor(() => expect(text()).toContain("Console: propose halt"));
      expect(calls.some((c) => c.path.startsWith("/api/v1/console/tools/propose_"))).toBe(false);
    });

    it("clears the saved conversation", async () => {
      const calls = setup({
        "GET /api/v1/console/threads": () => ({ body: { items: [{ id: "ct-9", title: "t", pinned: [], updatedAt: 1, expiresAt: 2, retentionDays: 90 }], retentionDays: 90 } }),
        "GET /api/v1/console/threads/ct-9": () => ({ body: { id: "ct-9", title: "t", pinned: ["WO-1042"], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-9", role: "user", text: "earlier question", at: 1, data: {} }, { id: "cm-2", threadId: "ct-9", role: "assistant", text: "earlier answer", at: 2, data: { mode: "model" } }] } }),
        "DELETE /api/v1/console/threads/ct-9": () => ({ body: { ok: true, msg: "Conversation cleared." } }),
      });
      mount("/chats");
      await waitFor(() => expect(text()).toContain("earlier answer"));
      await firstOf('#con-pins [data-entity="wo:WO-1042"]');
      fireEvent.click(await byId("con-chat-more-ct-9"));
      fireEvent.click(await waitFor(() => { const m = [...document.querySelectorAll("[role=menuitem]")].find((e) => /Delete/.test(e.textContent ?? "")); if (!m) throw new Error("no menu"); return m as HTMLElement; }));
      fireEvent.click(await waitFor(() => { const b = [...document.querySelectorAll("button")].find((e) => e.textContent === "Delete chat"); if (!b) throw new Error("no confirm"); return b; }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/console/threads/ct-9")).toBe(true));
      await waitFor(() => expect(text()).not.toContain("earlier answer"));
    });
  });
});

describe("ExplainDenial", () => {
  it("shows a model's explanation with its note", async () => {
    setup({ "POST /api/v1/console/explain": () => ({ body: { ok: true, mode: "model", explanation: "You need the Factory Admin role.", note: "Explained by a model from the policy trace. The deciding rule is authoritative.", person: "x", action: "kill.factory", decision: { allowed: false, reason: "r", rule: { id: "MATRIX" }, needs: "" }, trace: ["a"] } }) });
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><ExplainDenial id="x-explain" action="kill.factory" person="p-tomas" time={5} /></QueryClientProvider>);
    fireEvent.click(document.getElementById("x-explain")!);
    await waitFor(() => expect(document.querySelector(".explain-text")!.textContent).toBe("You need the Factory Admin role."));
    expect(document.querySelector(".explain-mode")!.textContent).toContain("deciding rule is authoritative");
  });

  it("shows the refusal when the explain endpoint refuses", async () => {
    setup({ "POST /api/v1/console/explain": () => ({ status: 422, body: { ok: false, msg: "Explaining another person's access needs the right to manage people." } }) });
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><ExplainDenial id="y-explain" action="kill.factory" person="p-asha" /></QueryClientProvider>);
    fireEvent.click(document.getElementById("y-explain")!);
    await waitFor(() => expect(document.querySelector(".explain-text")!.textContent).toContain("needs the right to manage people"));
  });
});

describe("slash parsing and the stream reader", () => {
  const P = [{ id: "payments", name: "Payments Platform", key: "PAY" }, { id: "risk", name: "Risk and Compliance", key: "RISK" }];
  const now = Date.UTC(2026, 10, 14, 6, 0);
  it("maps commands to tools and keeps changes as proposals", () => {
    expect(plan("/status risk", P, null, now)).toMatchObject({ kind: "tool", tool: "project_status", input: { project: "risk" } });
    expect(plan("/status", P, P[0]!, now)).toMatchObject({ tool: "project_status", input: { project: "payments" } });
    expect(plan("/halt payments-api duplicate refunds", P, P[0]!, now)).toMatchObject({ tool: "propose_halt", action: true, input: { scope: "repo", id: "payments-api" } });
    expect(plan("/halt payments duplicate refunds", P, null, now)).toMatchObject({ tool: "propose_halt", input: { scope: "project", id: "payments", reason: "duplicate refunds" } });
    expect(plan("/kill WO-2398 bad data", P, null, now)).toMatchObject({ tool: "propose_kill", input: { scope: "workorder", id: "WO-2398", reason: "bad data" } });
    expect(plan("/kill factory fire drill", P, null, now)).toMatchObject({ tool: "propose_kill", input: { scope: "factory", reason: "fire drill" } });
    expect(plan("/new payments-api: Fix refund rounding P1", P, P[0]!, now)).toMatchObject({ tool: "propose_submit_work_order", input: { project: "payments", repo: "payments-api", title: "Fix refund rounding", priority: "P1" } });
    expect(plan("/approve WO-2398", P, null, now)).toMatchObject({ tool: "propose_approve_gate", input: { wo: "WO-2398" } });
    expect(plan("/approve", P, null, now)).toMatchObject({ kind: "reply" });
    expect(plan("/changes payments 3 days", P, null, now)).toMatchObject({ tool: "events", input: { project: "payments", since_hours: 72 } });
    expect(plan("/who-can approve a gate in payments", P, null, now)).toMatchObject({ tool: "who_can", input: { action: "gate.approve", project: "payments" } });
  });
  it("reads server-sent events across chunk boundaries and skips broken blocks", () => {
    const r = new SseReader();
    expect(r.push('event: text\ndata: {"delta":"he')).toEqual([]);
    expect(r.push('llo"}\n\nevent: x\ndata: {not json}\n\nevent: done\ndata: {"messageId":"m"}\n\n')).toEqual([{ event: "text", data: { delta: "hello" } }, { event: "done", data: { messageId: "m" } }]);
  });
});

describe("Console model picker", () => {
  const M = (id: string, name: string, vendor: string, vendorName: string, tier: string, inPrice: number, outPrice: number) => ({ id, name, vendor, vendorName, tier, canonical: id, inPrice, outPrice, context: 200000 });
  const MODELS = [M("claude-sonnet-5-5", "Claude Sonnet 5.5", "anthropic", "Anthropic", "standard", 3, 15), M("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", "Anthropic", "fast", 1, 5), M("bedrock-claude-opus-5-5", "Claude Opus 5.5 (Bedrock)", "bedrock", "Amazon Bedrock", "frontier", 5, 25)];
  const WITH = { ...STATUS, models: MODELS, choice: null, defaultModel: "claude-sonnet-5-5", effectiveModel: "claude-sonnet-5-5", canManageModels: true };

  it("lists the callable models grouped by vendor with tier and price, defaulting to the routing default", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: WITH }) });
    mount("/settings");
    const sel = (await byId("con-model")) as HTMLSelectElement;
    expect(document.getElementById("con-mode")).toBeNull();
    expect([...sel.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Anthropic", "Amazon Bedrock"]);
    expect(sel.value).toBe("claude-sonnet-5-5");
    const opts = [...sel.options].map((o) => o.textContent);
    expect(opts[0]).toContain("default");
    expect(opts[1]).toContain("fast");
    expect(opts[2]).toContain("frontier");
    expect(opts[2]).toContain("5/25");
  });

  it("saves the person's choice on the server, and choosing the default clears it", async () => {
    const calls = setup({ "GET /api/v1/console/status": () => ({ body: WITH }), "PUT /api/v1/console/model": () => ({ body: { ok: true, msg: "Saved." } }) });
    mount("/settings");
    const sel = (await byId("con-model")) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "claude-haiku-5-5" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.path === "/api/v1/console/model")!.body).toEqual({ model: "claude-haiku-5-5" }));
    fireEvent.change(sel, { target: { value: "claude-sonnet-5-5" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/v1/console/model").at(-1)!.body).toEqual({ model: null }));
  });

  it("shows the saved choice when there is one", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: { ...WITH, choice: "claude-haiku-5-5", effectiveModel: "claude-haiku-5-5" } }) });
    mount("/settings");
    expect(((await byId("con-model")) as HTMLSelectElement).value).toBe("claude-haiku-5-5");
  });

  it("with nothing callable, a Factory Admin is offered Connect a model vendor", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: { ...NO_MODEL, models: [], canManageModels: true } }) });
    mount("/settings");
    const link = await byId("con-connect-vendor");
    expect(link.textContent).toBe("Connect a model vendor");
    expect(document.getElementById("con-mode")!.textContent).toBe("No model");
    fireEvent.click(link);
    expect(window.location.hash).toContain("models");
  });

  it("with nothing callable, anyone else is told to ask a Factory Admin", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: { ...NO_MODEL, models: [], canManageModels: false } }) });
    mount("/settings");
    await waitFor(() => expect(document.getElementById("con-mode-reason")!.textContent).toContain("Ask a Factory Admin"));
    expect(document.getElementById("con-connect-vendor")).toBeNull();
  });

  it("the Console is a general chat: a plain line says what it is, the chat list and the chat are side by side, nothing is pinned to a side panel", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    mount();
    await byId("con-form");
    expect(document.querySelector(".vhead")!.textContent).toContain("Ask Gantry anything about your factory. Answers come from live data, and nothing changes without your approval.");
    expect(document.getElementById("con-chats")).toBeTruthy();
    expect(document.getElementById("con-new-chat")).toBeTruthy();
    expect(document.getElementById("con-new-wo")).toBeTruthy();
    expect(document.getElementById("con-scope")).toBeTruthy();
    for (const id of ["con-bar", "con-more", "con-settings"]) expect(document.getElementById(id)).toBeNull();
    expect([...document.querySelectorAll(".panel-title")].map((h) => h.textContent)).not.toContain("Pinned work orders");
    expect(document.body.textContent).not.toContain("Pinned work orders");
  });

  it("the header has a visible New chat button (the only one on a phone, where the list is hidden) that opens a new chat", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    mount();
    const b = await byId("con-head-new");
    expect(document.getElementById("con-head")!.contains(b)).toBe(true);
    fireEvent.click(b);
    await waitFor(() => expect(location.hash).toBe("#console/new"));
  });

  it("the Console page no longer carries the old conversation bar, the legacy chat list or pinned-work-orders controls", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    mount();
    await byId("con-form");
    for (const id of ["con-bar", "con-threads", "con-new", "con-clear", "con-foot-sug-0", "con-unpin-WO-1042"]) expect(document.getElementById(id)).toBeNull();
    expect(document.querySelector(".try-lbl")).toBeNull();
  });

  it("the workspace's embedded chat carries no hard-coded suggestion chips, no Try label and no dangling hint (G-03)", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    bindQueryClient(qc);
    render(<QueryClientProvider client={qc}><OverlayProvider><ConsoleView embed={{ threadId: null, onThread: () => undefined, page: true }} /></OverlayProvider></QueryClientProvider>);
    await byId("con-form");
    expect(document.querySelector(".sugg, .try-lbl")).toBeNull();
    expect(text()).not.toContain("Try one of the suggestions");
    expect(text()).not.toContain("Pinned work orders");
  });

  it("opening the Console focuses the composer without scrolling the page (the title stays in view on a phone)", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    const spy = vi.spyOn(HTMLElement.prototype, "focus");
    mount();
    await byId("con-input");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.every((c) => (c[0] as FocusOptions | undefined)?.preventScroll === true)).toBe(true);
    spy.mockRestore();
  });

  it("Settings open in place under the chat header (not below the fold), with the model, the console's rights and the audit link; Close hides them", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: STATUS }) });
    mount();
    fireEvent.click(await byId("con-open-settings"));
    const panel = await byId("con-settings");
    expect(document.getElementById("con2-main")!.contains(panel)).toBe(true);
    expect(document.getElementById("con-open-settings")!.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect([...document.querySelectorAll("#con-settings .caps .cap-code")].map((c) => c.textContent)).toContain("gate.approve"));
    expect(document.getElementById("con-open-audit")).toBeTruthy();
    fireEvent.click(document.getElementById("con-aux-close")!);
    expect(document.getElementById("con-settings")).toBeNull();
  });

  it("the page carries no hard-coded suggestion chips: the console API supplies none", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    mount();
    await byId("con-form");
    expect(document.getElementById("con-chips")).toBeNull();
    expect(document.querySelector(".chipbtn, .sugg")).toBeNull();
    for (const t of ["What is blocked?", "What waits on a person?", "Spend this month"]) expect(text()).not.toContain(t);
  });

  it("the work orders a chat mentions show as chips in that chat, linking to the record; there is no side panel", async () => {
    setup({
      "GET /api/v1/console/threads": () => ({ body: { items: [{ id: "ct-p", title: "t", pinned: ["WO-1042"], updatedAt: 1, expiresAt: 2, retentionDays: 90 }], retentionDays: 90 } }),
      "GET /api/v1/console/threads/ct-p": () => ({ body: { id: "ct-p", title: "t", pinned: ["WO-1042"], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [] } }),
    });
    mount();
    const pin = await firstOf('#con-pins [data-entity="wo:WO-1042"]');
    expect(document.getElementById("con-pins")!.contains(pin)).toBe(true);
    expect(document.getElementById("con-thread")!.contains(pin)).toBe(false);
    fireEvent.submit(document.getElementById("con-form")!);
    await waitFor(() => expect(text()).toContain("Type a question first"));
  });

  it("the composer is pinned under the messages, which scroll on their own and open at the newest", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: STATUS }) });
    mount();
    const log = await byId("con-thread");
    const form = document.getElementById("con-form")!;
    expect(log.parentElement).toBe(form.parentElement);
    expect(log.nextElementSibling).toBe(form);
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });
    await ask("hello");
    await waitFor(() => expect(log.scrollTop).toBe(900));
    const css = readFileSync(resolve(__dirname, "../styles/views/console.css"), "utf8");
    expect(/\.con2-log \{[^}]*overflow-y: auto/.test(css)).toBe(true);
  });

  it("the status line sits below the header rule: no negative margin pulls it into the heading", () => {
    const css = readFileSync(resolve(__dirname, "../styles/views/console.css"), "utf8");
    const rule = /\.con-mode-line \{[^}]*\}/.exec(css)![0];
    expect(rule).not.toMatch(/margin:[^;]*calc\(-/);
  });
});

describe("Console transcript: no duplicates, finalised answers, retry", () => {
  const thread = (messages: unknown[]) => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages } });
  const userMsg = (id: string, t: string, at = Date.now()) => ({ id, threadId: "ct-1", role: "user", text: t, at, data: {} });
  const answer = (id: string, t: string, at = Date.now() + 5) => ({ id, threadId: "ct-1", role: "assistant", text: t, at, data: { mode: "model", cited: [], proposals: [] } });

  it("shows the question once when the saved copy arrives mid-stream, and the saved answer replaces the partial one", async () => {
    const enc = new TextEncoder();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let saved = false;
    const full = "First paragraph.\n\n**Slow gates:** none.\n\n- one\n- two";
    setup({
      "POST /api/v1/console/messages": () => ({ open: () => new ReadableStream({ start(c) { ctl = c; c.enqueue(enc.encode(sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["text", { delta: "First paragraph." }]))); } }) }),
      "GET /api/v1/console/threads/ct-1": () => thread(saved ? [userMsg("cm-1", "get going"), answer("cm-2", full)] : [userMsg("cm-1", "get going")]),
    });
    mount();
    await ask("get going");
    await waitFor(() => expect(text()).toContain("First paragraph."));
    await waitFor(() => expect(document.querySelectorAll(".msg-user").length).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll(".msg-user").length).toBe(1);
    expect(text()).toContain("Model · streaming");
    saved = true;
    ctl.enqueue(enc.encode(sse(["done", { messageId: "cm-2", text: full, mode: "model", model: "claude-test-1", cited: [], proposals: [] }])));
    ctl.close();
    await waitFor(() => expect(document.querySelector("#con-msg-text-cm-2 strong")?.textContent).toBe("Slow gates:"));
    expect(text()).not.toContain("streaming");
    expect(text()).not.toContain("**");
    expect(document.querySelectorAll("#con-msg-text-cm-2 li").length).toBe(2);
    expect(document.querySelectorAll(".msg-user").length).toBe(1);
    expect(document.querySelectorAll(".msg-factory").length).toBe(1);
  });

  it("a failed answer offers Retry, which asks again without showing the question twice", async () => {
    let posts = 0;
    const errText = "The model did not answer: The model vendor could not be reached.";
    setup({
      "POST /api/v1/console/messages": () => (++posts === 1
        ? { sse: sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["error", { code: "api_error", msg: errText, messageId: "cm-2" }]) }
        : { sse: sse(["thread", { threadId: "ct-1", messageId: "cm-3", created: false }], ["done", { messageId: "cm-4", text: "All good.", mode: "model", cited: [], proposals: [] }]) }),
      "GET /api/v1/console/threads/ct-1": () => thread(posts < 2
        ? [userMsg("cm-1", "check the pr", 1000), { id: "cm-2", threadId: "ct-1", role: "system", text: errText, at: 1001, data: { kind: "api_error" } }]
        : [userMsg("cm-1", "check the pr", 1000), { id: "cm-2", threadId: "ct-1", role: "system", text: errText, at: 1001, data: { kind: "api_error" } }, userMsg("cm-3", "check the pr", Date.now()), answer("cm-4", "All good.", Date.now() + 5)]),
    });
    mount();
    await ask("check the pr");
    fireEvent.click(await byId("con-retry"));
    await waitFor(() => expect(text()).toContain("All good."));
    expect(posts).toBe(2);
    expect(document.querySelectorAll(".msg-user").length).toBe(1);
    expect(text()).not.toContain("could not be reached");
    expect(document.getElementById("con-retry")).toBeNull();
  });
});

describe("Markdown (assistant text is untrusted)", () => {
  const html = (t: string) => { const d = document.createElement("div"); document.body.appendChild(d); const r = render(<Markdown text={t} />, { container: d }); return r.container; };
  it("renders bold, italic, inline code, code blocks and lists", () => {
    const c = html("**b** and *i* and `c`\n\n- a\n- b\n\n1. x\n2. y\n\n```\nconst a = 1;\n```");
    expect(c.querySelector("strong")!.textContent).toBe("b");
    expect(c.querySelector("em")!.textContent).toBe("i");
    expect(c.querySelector("p code")!.textContent).toBe("c");
    expect(c.querySelectorAll("ul li").length).toBe(2);
    expect(c.querySelectorAll("ol li").length).toBe(2);
    expect(c.querySelector("pre code")!.textContent).toBe("const a = 1;");
  });
  it("allows http(s) and hash links only, with rel=noopener, and never injects HTML", () => {
    const c = html("[ok](https://x.dev/a) [bad](javascript:alert(1)) [in](#floor) <img src=x onerror=alert(1)> <script>alert(1)</script>");
    const links = [...c.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://x.dev/a", "#floor"]);
    expect(links[0]!.getAttribute("rel")).toContain("noopener");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    expect(c.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("Console chats", () => {
  const th = (id: string, title: string, text: string, ago: number) => ({ id, title, pinned: [], createdAt: Date.now() - ago, updatedAt: Date.now() - ago, expiresAt: Date.now() + 1e9, retentionDays: 90, count: 2, messages: [{ id: `${id}-m1`, threadId: id, role: "user", text, at: Date.now() - ago, data: {} }, { id: `${id}-m2`, threadId: id, role: "assistant", text: `Answer to ${text}`, at: Date.now() - ago, data: { mode: "model" } }] });
  const A = th("ct-a", "Payments gates", "Which gates wait on me?", 60_000);
  const B = th("ct-b", "Release notes", "Summarise WO-1002", 3_600_000);
  const chats = () => setup({
    "GET /api/v1/console/threads": () => ({ body: { items: [A, B].map(({ messages: _m, ...t }) => t), retentionDays: 90 } }),
    "GET /api/v1/console/threads/ct-a": () => ({ body: A }),
    "GET /api/v1/console/threads/ct-b": () => ({ body: B }),
    "PATCH /api/v1/console/threads/ct-b": () => ({ body: { ok: true, msg: "Renamed.", title: "Release notes Nov" } }),
  });

  it("lists saved chats newest first, opens the latest, and switches to another", async () => {
    chats();
    mount("/chats");
    expect((await byId("con-chat-ct-a")).getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(text()).toContain("Which gates wait on me?"));
    fireEvent.click(await byId("con-chat-ct-b"));
    await waitFor(() => expect(text()).toContain("Summarise WO-1002"));
    expect(text()).not.toContain("Which gates wait on me?");
    expect(document.getElementById("con-chat-ct-b")!.getAttribute("aria-current")).toBe("true");
  });

  it("New chat starts an empty conversation without deleting the others", async () => {
    const calls = chats();
    mount("/chats");
    await waitFor(() => expect(text()).toContain("Which gates wait on me?"));
    fireEvent.click(await byId("con-new-chat"));
    await waitFor(() => expect(text()).not.toContain("Which gates wait on me?"));
    expect(document.getElementById("con-chat-ct-a")!.getAttribute("aria-current")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("renames a chat from its menu", async () => {
    const calls = chats();
    mount("/chats");
    fireEvent.click(await byId("con-chat-more-ct-b"));
    fireEvent.click(await waitFor(() => { const m = [...document.querySelectorAll("[role=menuitem]")].find((e) => /Rename/.test(e.textContent ?? "")); if (!m) throw new Error("no menu"); return m as HTMLElement; }));
    const name = (await byId("con-chat-name")) as HTMLInputElement;
    expect(name.value).toBe("Release notes");
    fireEvent.change(name, { target: { value: "Release notes Nov" } });
    fireEvent.click(await byId("con-chat-rename-ok"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Release notes Nov" }));
  });
});

describe("Console page layout", () => {
  it("has a one-line message input in a left chat list and chat layout, and the agent answers as Gantry on the left, the person on the right", async () => {
    setup({ "GET /api/v1/console/status": () => ({ body: NO_MODEL }) });
    mount();
    const input = (await byId("con-input")) as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-label")).toBe("Message Gantry");
    expect(document.querySelector(".con2 > .con2-list")).toBeTruthy();
    expect(document.querySelector(".con2 > .con2-main")).toBeTruthy();
    await ask("status of WO-1042");
    await waitFor(() => expect(document.querySelector(".msg.me .bub .who")).toBeTruthy());
    expect(document.querySelector(".msg:not(.me) .who")?.textContent).toMatch(/^Gantry( · \d\d:\d\d)?$/);
    expect(document.querySelector(".msg:not(.me) .avatar")?.textContent).toBe("G");
  });
});

describe("Console chats in the URL and the chat list", () => {
  const th = (id: string, title: string) => ({ id, title, pinned: [], createdAt: 1, updatedAt: Date.now() - 1000, expiresAt: Date.now() + 1e9, retentionDays: 90, messages: [{ id: `${id}-m`, threadId: id, role: "user", text: `hello from ${title}`, at: 1, data: {} }] });
  const A = th("ct-a", "Payments gates"), B = th("ct-b", "Release notes");
  const chats = (extra: Record<string, Handler> = {}) => setup({
    "GET /api/v1/console/threads": () => ({ body: { items: [A, B].map(({ messages: _m, ...t }) => t), retentionDays: 90 } }),
    "GET /api/v1/console/threads/ct-a": () => ({ body: A }),
    "GET /api/v1/console/threads/ct-b": () => ({ body: B }),
    ...extra,
  });

  it("opens the chat in the URL, picking a chat puts it in the URL, and New chat goes to #console/new with an empty chat", async () => {
    chats();
    window.location.hash = "#console/ct-b";
    mount();
    await waitFor(() => expect(text()).toContain("hello from Release notes"));
    expect(document.getElementById("con-chat-ct-b")!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(await byId("con-chat-ct-a"));
    await waitFor(() => expect(text()).toContain("hello from Payments gates"));
    expect(window.location.hash).toBe("#console/ct-a");
    fireEvent.click(await byId("con-new-chat"));
    await waitFor(() => expect(text()).not.toContain("hello from Payments gates"));
    expect(window.location.hash).toBe("#console/new");
    expect(document.getElementById("con-title")!.textContent).toBe("New conversation");
    expect(document.querySelector(".con2-chat[aria-current]")).toBeNull();
  });

  it("a first message in a new chat starts it with All projects as its scope and moves the URL to the new chat", async () => {
    const calls = chats({
      "POST /api/v1/console/messages": () => ({ sse: sse(["thread", { threadId: "ct-a", messageId: "cm-1", created: true }], ["text", { delta: "ok" }], ["done", { messageId: "cm-2", text: "ok", mode: "model", model: "claude-test-1", cited: [], proposals: [] }]) }),
    });
    window.location.hash = "#console/new";
    mount();
    expect((await byId("con-scope") as HTMLSelectElement).value).toBe("");
    await ask("what is going on?");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/v1/console/messages")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/console/messages")!.body.project).toBeUndefined();
    await waitFor(() => expect(window.location.hash).toBe("#console/ct-a"));
  });

  it("choosing a project scope for the chat sends it with the message", async () => {
    const calls = chats({ "POST /api/v1/console/messages": () => ({ sse: sse(["done", { messageId: "cm-2", text: "ok", mode: "model", cited: [], proposals: [] }]) }) });
    window.location.hash = "#console/new";
    mount();
    type(await byId("con-scope"), "payments");
    await ask("anything?");
    await waitFor(() => expect(calls.find((c) => c.path === "/api/v1/console/messages")?.body.project).toBe("payments"));
  });

  it("lists Recent and Shared with me groups, with the scope and last activity on each row", async () => {
    chats({
      "GET /api/v1/workspace/inbox": () => ({ body: { items: [
        { key: "ct-a", kind: "chat", scope: { kind: "project", id: "payments", label: "Payments Platform" }, project: "payments", title: "Payments gates", mine: true, shared: false, visibility: "private", updatedAt: Date.now() },
        { key: "ct-z", kind: "chat", scope: { kind: "factory", id: null, label: "Factory" }, project: null, title: "Shared by Meera", mine: false, shared: true, visibility: "project", updatedAt: Date.now() },
      ] } }),
    });
    mount();
    await waitFor(() => expect(document.getElementById("con-chat-ct-z")).toBeTruthy());
    const heads = [...document.querySelectorAll(".con2-group")].map((h) => h.textContent);
    expect(heads).toEqual(["Recent", "Shared with me"]);
    expect(document.getElementById("con-chat-ct-a")!.textContent).toContain("Payments Platform");
    expect(document.getElementById("con-chat-ct-z")!.textContent).toContain("All projects");
  });

  it("the old workspace routes go to the Console", async () => {
    const { default: WorkspaceView } = await import("./workspace");
    chats({ "GET /api/v1/workspace/inbox": () => ({ body: { items: [] } }) });
    window.location.hash = "#workspace/new";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    bindQueryClient(qc);
    render(<QueryClientProvider client={qc}><OverlayProvider><WorkspaceView /></OverlayProvider></QueryClientProvider>);
    await waitFor(() => expect(window.location.hash).toBe("#console/new"));
    window.location.hash = "#workspace/chats";
    await waitFor(() => expect(window.location.hash).toBe("#console"));
  });

  it("Submit work order is one click from the Console header, named as on every other screen", async () => {
    chats();
    mount();
    const b = await byId("con-new-wo");
    expect(b.textContent).toContain("Submit work order");
    expect(document.querySelector(".vhead")!.contains(b)).toBe(true);
  });
});
