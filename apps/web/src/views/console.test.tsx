import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  bindQueryClient(qc);
  return render(<QueryClientProvider client={qc}><OverlayProvider><ConsoleView /></OverlayProvider></QueryClientProvider>);
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.path !== "/api/v1/can");
const firstOf = (sel: string) => waitFor(() => { const e = document.querySelector<HTMLElement>(sel); if (!e) throw new Error(`no ${sel}`); return e; });
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } });
const ask = async (text: string) => { type(await byId("con-input"), text); fireEvent.submit(document.getElementById("con-form")!); };
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
      mount();
      const badge = await byId("con-mode");
      await waitFor(() => expect(badge.textContent).toBe("No model"));
      expect(badge.className).toContain("ask-absent");
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("No model is configured");
      expect(text()).toContain("slash commands read live data directly");
      expect(text()).not.toContain("is answered by");
    });

    it("a question gets the clear notice, not an answer", async () => {
      const calls = setup({
        "GET /api/v1/console/status": () => ({ body: NO_MODEL }),
        "POST /api/v1/console/messages": () => ({ sse: sse(["thread", { threadId: "ct-1", messageId: "cm-1", created: true }], ["unavailable", { code: "no_model_configured", msg: NO_MODEL.reason, messageId: "cm-2" }], ["done", { messageId: "cm-2", text: NO_MODEL.reason, mode: "none", cited: [], proposals: [] }]) }),
        "GET /api/v1/console/threads/ct-1": () => ({ body: { id: "ct-1", title: "x", pinned: [], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-1", role: "user", text: "What is waiting on me?", at: Date.now() - 10, data: {} }, { id: "cm-2", threadId: "ct-1", role: "system", text: NO_MODEL.reason, at: Date.now(), data: { kind: "no_model" } }] } }),
      });
      mount();
      await ask("What is waiting on me?");
      await waitFor(() => expect(document.querySelectorAll(".msg-mode.is-none").length).toBe(1));
      expect(document.querySelector(".msg-mode.is-none")!.textContent).toBe("No model configured");
      expect(text()).toContain("Ask a Factory Admin to connect a model vendor");
      const post = calls.find((c) => c.path === "/api/v1/console/messages")!;
      expect(post.body).toEqual({ text: "What is waiting on me?", via: "console", project: "payments" });
      expect(post.headers["idempotency-key"]).toBeTruthy();
      expect(post.headers["x-csrf-token"]).toBe("c");
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
      mount();
      await waitFor(() => expect(document.getElementById("con-mode")!.textContent).toBe("Model"));
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("claude-test-1");
      expect(document.getElementById("con-mode-reason")!.textContent).toContain("read-only");
      await ask("Why is WO-1042 stuck?");
      await waitFor(() => expect(document.querySelector(".msg-mode.is-model")?.textContent).toBe("claude-test-1"));
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
      mount();
      await ask("Look at the gates");
      await waitFor(() => expect(text()).toContain("Looking at the gates"));
      expect(document.getElementById("con-send")!.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(await byId("con-stop"));
      await waitFor(() => expect(aborted).toBe(true));
      await waitFor(() => expect(document.querySelector(".msg-mode.is-model")?.textContent).toContain("stopped"));
      expect(document.getElementById("con-stop")).toBeNull();
    });

    it("a refused send is shown as the reason, not as an answer", async () => {
      setup({ "POST /api/v1/console/messages": () => ({ status: 404, body: { ok: false, msg: "No such conversation." } }) });
      mount();
      await ask("hello");
      await waitFor(() => expect(document.querySelector(".msg-mode.is-error")?.textContent).toBe("Model did not answer"));
      expect(text()).toContain("No such conversation.");
    });
  });

  describe("slash commands run the tools directly, with no model", () => {
    it("/projects reads list_projects and draws the table", async () => {
      const calls = setup({
        "GET /api/v1/console/status": () => ({ body: NO_MODEL }),
        "POST /api/v1/console/tools/*": (_u, _i, b) => ({ body: { ok: true, tool: "list_projects", result: [{ id: "payments", name: "Payments Platform", key: "PAY", status: "active", halted: null, killed: null, inFlight: 3, waitingAtGates: 1, inBays: 0, health: "Healthy" }], proposals: [], cited: [] } }),
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

    it("an action command says actions are off and calls nothing", async () => {
      const calls = setup();
      mount();
      await ask("/halt payments duplicate refunds");
      await waitFor(() => expect(text()).toContain("Console actions are switched off for this factory"));
      expect(calls.some((c) => c.path.startsWith("/api/v1/console/tools/"))).toBe(false);
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
    const ON = { "GET /api/v1/console/status": () => ({ body: { ...STATUS, actionsEnabled: true, version: 1 } }) };
    const tool = (name: string, p: object) => ({ [`POST /api/v1/console/tools/${name}`]: () => ({ body: { ok: true, tool: name, result: { proposed: "PROP-1" }, proposals: [p], cited: [] } }) });

    it("a halt asks for a reason, then calls the ordinary endpoint with via console and an Idempotency-Key", async () => {
      const calls = setup({ ...ON, ...tool("propose_halt", proposal()), "POST /api/v1/stops": () => ({ body: { ok: true, msg: "Payments Platform halted." } }) });
      mount();
      await waitFor(() => expect(document.getElementById("con-actions")).toBeTruthy());
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
      mount();
      await waitFor(() => expect(document.getElementById("con-actions")).toBeTruthy());
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
      mount();
      await waitFor(() => expect(document.getElementById("con-actions")).toBeTruthy());
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
      mount();
      await ask("halt payments, duplicate refunds");
      const ok = await waitFor(() => { const e = document.querySelector<HTMLElement>("[id^='con-cf-ok-']"); if (!e) throw new Error("no card"); return e; });
      fireEvent.click(ok);
      await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/v1/console/messages/cm-2/proposals/PROP-1")).toBe(true));
      expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/PROP-1"))!.body).toEqual({ status: "done", result: "Halted." });
    });

    it("a refusal from the endpoint ends the card as failed and says why", async () => {
      setup({ ...ON, ...tool("propose_halt", proposal()), "POST /api/v1/stops": () => ({ status: 403, body: { ok: false, msg: "Payments Platform is halted already." } }) });
      mount();
      await waitFor(() => expect(document.getElementById("con-actions")).toBeTruthy());
      await ask("/halt payments dup refunds");
      fireEvent.click(await firstOf("[id^='con-cf-ok-']"));
      await waitFor(() => expect(document.querySelector(".ccard-confirm.is-failed")).toBeTruthy());
      expect(text()).toContain("Payments Platform is halted already.");
    });
  });

  describe("context panel and settings", () => {
    it("lists what the person can do in the current project, with reasons for what they cannot", async () => {
      setup({}, ["kill.factory"]);
      mount();
      const caps = await waitFor(() => { const c = document.querySelector(".caps"); if (!c || !c.querySelector("li.no")) throw new Error("not yet"); return c; });
      const no = caps.querySelector("li.no")!;
      expect(no.textContent).toContain("Kill the factory");
      expect(no.getAttribute("data-tip")).toBe("No role holds kill.factory.");
      expect(caps.querySelectorAll("li.ok").length).toBe(9);
      expect(document.querySelector(".mini-log")!.textContent).toContain("Payments Platform");
    });

    it("the actions switch is locked with the reason without the right, and turning it on asks for a reason and sends the version", async () => {
      const calls = setup({ "PUT /api/v1/console/settings": () => ({ body: { ok: true, msg: "Console actions are on.", actionsEnabled: true, version: 1 } }) }, ["security.manage"]);
      const r = mount();
      const sw = await byId("con-actions");
      await waitFor(() => expect(sw.getAttribute("aria-disabled")).toBe("true"));
      fireEvent.click(sw);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      r.unmount();
      cleanup();
      canBatcher.clear();
      const calls2 = setup({ "PUT /api/v1/console/settings": () => ({ body: { ok: true, msg: "Console actions are on.", actionsEnabled: true, version: 1 } }) });
      mount();
      const sw2 = await byId("con-actions");
      await waitFor(() => expect(sw2.getAttribute("aria-disabled")).not.toBe("true"));
      fireEvent.click(sw2);
      const dlg = await waitFor(() => { const d = document.querySelector<HTMLElement>("[role='dialog']"); if (!d) throw new Error("no dialog"); return d; });
      expect(dlg.textContent).toContain("Turn console actions on");
      const ta = dlg.querySelector<HTMLElement>("input, textarea")!;
      type(ta, "pilot with the admins");
      fireEvent.click(within(dlg).getByText("Turn on"));
      await waitFor(() => expect(calls2.some((c) => c.method === "PUT" && c.path === "/api/v1/console/settings")).toBe(true));
      const put = calls2.find((c) => c.method === "PUT")!;
      expect(put.body).toEqual({ actionsEnabled: true, reason: "pilot with the admins" });
      expect(put.headers["if-match"]).toBe("0");
    });

    it("clears the saved conversation", async () => {
      const calls = setup({
        "GET /api/v1/console/threads": () => ({ body: { items: [{ id: "ct-9", title: "t", pinned: [], updatedAt: 1, expiresAt: 2, retentionDays: 90 }], retentionDays: 90 } }),
        "GET /api/v1/console/threads/ct-9": () => ({ body: { id: "ct-9", title: "t", pinned: ["WO-1042"], createdAt: 0, updatedAt: 0, expiresAt: 0, retentionDays: 90, messages: [{ id: "cm-1", threadId: "ct-9", role: "user", text: "earlier question", at: 1, data: {} }, { id: "cm-2", threadId: "ct-9", role: "assistant", text: "earlier answer", at: 2, data: { mode: "model" } }] } }),
        "DELETE /api/v1/console/threads/ct-9": () => ({ body: { ok: true, msg: "Conversation cleared." } }),
      });
      mount();
      await waitFor(() => expect(text()).toContain("earlier answer"));
      expect(document.getElementById("con-pin-WO-1042")).toBeTruthy();
      fireEvent.click(await byId("con-clear"));
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
