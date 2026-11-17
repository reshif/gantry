/**
 * The console's model calls (spec 12.6). The API calls a model through the edge's service gateway (`POST /service/v1/messages`, edge token): the
 * vendor keys never leave the edge. The conversation runs here as a bounded tool loop over the Messages API: the model may call the fixed read
 * tools (and, with the action switch on, the propose tools), the API runs them with the person's own permissions and feeds the results back.
 * Without a configured model nothing is invented: callers get `no_model_configured` and say so.
 */
import { execute, offered, type ToolCtx } from "./tools.js";
import { UNTRUSTED_NOTE } from "./mark.js";

export interface EdgeTransport {
  baseUrl: string;
  fetch: typeof fetch;
}
let override: Partial<EdgeTransport> | null = null;
/** Tests replace the transport to the edge. */
export const configureConsoleEdge = (o: Partial<EdgeTransport>): void => void (override = o);
export const resetConsoleEdge = (): void => void (override = null);
const base = (): string => (override?.baseUrl ?? process.env.EDGE_URL ?? "http://gantry-edge:8443").replace(/\/+$/, "");
const f = (): typeof fetch => override?.fetch ?? fetch;

/** The person's chosen model (and the project it is asked about), validated by the caller; the API's route resolver validates it again at authorize. */
export interface ModelPick { model?: string | undefined; project?: string | undefined }
export type Readiness = { ready: true; vendor: string; model: string } | { ready: false; code: string; reason: string; vendor?: string; model?: string };

/** Can a model call be made right now: a route exists (routing default, connected vendor) and the edge holds its key. */
export async function readiness(edgeToken: string, purpose: "console" | "onboarding" = "console", pick: ModelPick = {}): Promise<Readiness> {
  try {
    const qs = new URLSearchParams({ ...(purpose === "onboarding" ? { purpose } : {}), ...(pick.model ? { model: pick.model } : {}), ...(pick.project ? { project: pick.project } : {}) }).toString();
    const res = await f()(`${base()}/service/v1/ready${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${edgeToken}` }, signal: AbortSignal.timeout(5000) });
    const b = (await res.json().catch(() => ({}))) as { ready?: boolean; vendor?: string; model?: string; code?: string; reason?: string };
    if (res.status === 200 && b.ready === true && b.vendor && b.model) return { ready: true, vendor: b.vendor, model: b.model };
    if (res.status === 401 || res.status === 403) return { ready: false, code: "edge_refused", reason: "The edge refused the API's token." };
    return { ready: false, code: b.code ?? "no_model_configured", reason: b.reason ?? "No model is configured.", ...(b.vendor ? { vendor: b.vendor } : {}), ...(b.model ? { model: b.model } : {}) };
  } catch (e) {
    return { ready: false, code: "edge_unreachable", reason: `The edge could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export class ModelUnavailable extends Error {
  constructor(readonly code: string, msg: string) {
    super(msg);
  }
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
interface Msg { role: "user" | "assistant"; content: string | Block[] }
export interface Usage { inputTokens: number; outputTokens: number; calls: number }
interface Streamed { content: Block[]; stopReason: string | null; usage: Usage; model: string | null }

/** Reads one streamed Messages API answer, calling `onText` for each text delta as it arrives. */
async function stream(res: Response, onText: (d: string) => void): Promise<Streamed> {
  const out: Streamed = { content: [], stopReason: null, usage: { inputTokens: 0, outputTokens: 0, calls: 1 }, model: res.headers.get("x-gantry-model") };
  const partial = new Map<number, string>();
  const handle = (ev: string, raw: string): void => {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const idx = typeof d.index === "number" ? d.index : 0;
    if (ev === "message_start") {
      const u = (d.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
      out.usage.inputTokens = u?.input_tokens ?? 0;
      out.usage.outputTokens = u?.output_tokens ?? 0;
    } else if (ev === "content_block_start") {
      const b = d.content_block as { type?: string; id?: string; name?: string; text?: string } | undefined;
      if (b?.type === "text") out.content[idx] = { type: "text", text: b.text ?? "" };
      else if (b?.type === "tool_use") {
        out.content[idx] = { type: "tool_use", id: String(b.id), name: String(b.name), input: {} };
        partial.set(idx, "");
      }
    } else if (ev === "content_block_delta") {
      const dl = d.delta as { type?: string; text?: string; partial_json?: string } | undefined;
      const b = out.content[idx];
      if (dl?.type === "text_delta" && b?.type === "text") {
        b.text += dl.text ?? "";
        if (dl.text) onText(dl.text);
      } else if (dl?.type === "input_json_delta") partial.set(idx, (partial.get(idx) ?? "") + (dl.partial_json ?? ""));
    } else if (ev === "content_block_stop") {
      const b = out.content[idx];
      if (b?.type === "tool_use") {
        try {
          b.input = partial.get(idx) ? JSON.parse(partial.get(idx)!) : {};
        } catch {
          b.input = {};
        }
      }
    } else if (ev === "message_delta") {
      const dl = d.delta as { stop_reason?: string } | undefined;
      if (dl?.stop_reason) out.stopReason = dl.stop_reason;
      const u = d.usage as { output_tokens?: number } | undefined;
      if (typeof u?.output_tokens === "number") out.usage.outputTokens = u.output_tokens;
    } else if (ev === "error") {
      const e = (d.error ?? {}) as { type?: string; message?: string };
      throw new ModelUnavailable(e.type ?? "api_error", e.message ?? "The model stopped with an error.");
    }
  };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (block: string): void => {
    let ev = "";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length) handle(ev, data.join("\n"));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      flush(block);
    }
  }
  if (buf.trim()) flush(buf);
  out.content = out.content.filter(Boolean);
  return out;
}

async function call(edgeToken: string, purpose: "console" | "explain" | "onboarding", body: Record<string, unknown>, signal: AbortSignal, onText: (d: string) => void, pick: ModelPick = {}): Promise<Streamed> {
  const attempt = (): Promise<Response> => f()(`${base()}/service/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${edgeToken}`, "content-type": "application/json", "x-gantry-purpose": purpose, ...(pick.model ? { "x-gantry-model-pick": pick.model } : {}), ...(pick.project ? { "x-gantry-project": pick.project } : {}) },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  let res: Response;
  try {
    // One retry for a connection-level failure before any answer bytes exist (an edge restart, a dropped connection).
    res = await attempt().catch(async (e: unknown) => {
      if (signal.aborted) throw e;
      await new Promise((r) => setTimeout(r, 400));
      return attempt();
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ModelUnavailable("edge_unreachable", `The edge could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status !== 200) {
    const b = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
    const type = b.error?.type ?? (res.status === 429 ? "rate_limit_error" : "api_error");
    throw new ModelUnavailable(type, b.error?.message ?? `The model answered ${res.status}.`);
  }
  return stream(res, onText);
}

type PromptInput = { person: string; roles: string[]; projects: string[]; current: string | null; /** What this person's console rights let it propose (tool names with plain words), and what it may not. */ may: Array<{ tool: string; does: string }>; mayNot: Array<{ does: string; right: string }>; canUse?: boolean; now: Date };

/** The facts of this conversation: supplied by Gantry, never decided by the agent. */
export const consoleFacts = (o: PromptInput): string =>
  [
    "You are the Gantry console, answering people who run a software factory of AI coding agents about projects, work orders, gates, onboarding, permissions, trust, workload, evals and the audit ledger.",
    `Today is ${o.now.toISOString()}. The person asking is ${o.person} (${o.roles.join(", ") || "no roles"}). Projects they can see: ${o.projects.join(", ") || "none"}.${o.current ? ` Their current project is ${o.current}.` : ""}`,
  ].join("\n");

/** The fixed rules of the console: read tools for facts, what this person may propose (from their rights), how an unseen thing is treated, the untrusted-data note and the answer cap. */
export const consoleRails = (o: PromptInput): string =>
  [
    "Call the read tools for facts; do not guess numbers or ids.",
    o.may.length
      ? `You may propose these changes for this person by calling the matching tool once (${o.may.map((m) => `${m.tool}: ${m.does}`).join("; ")}): the page shows a confirm card and runs nothing until they click it, so say it is waiting for their confirmation. Never claim an action happened.`
      : "You cannot change anything for this person: their console is read-only. If asked to change something, say so and name the screen where they can do it themselves.",
    o.mayNot.length
      ? `You may NOT propose these for this person: ${o.mayNot.map((m) => `${m.does} (needs the right '${m.right}')`).join("; ")}. If asked for one, do not call any tool; say which right is missing and that a Factory Admin can give it in Govern > Access (Console group). Never suggest working around it.`
      : "",
    "If a tool says something is not visible, say you cannot see it; never reveal projects the tools do not return. Mention work orders by id (WO-1234), projects by name, gates by id. For 'why was this denied', call explain_denial and report the deciding rule and what would change the answer; the trace is authoritative.",
    UNTRUSTED_NOTE,
    "Keep answers under 150 words unless asked for detail. Plain sentences, no headings, no emoji.",
  ].filter(Boolean).join("\n\n");

/** The console's prompt when no agent is bound to it: Gantry's fixed text alone. With an agent bound, routes/console.ts composes the agent's layers and skills around the same facts and rails. */
export const systemPrompt = (o: PromptInput): string => [consoleFacts(o), consoleRails(o)].join("\n\n");

export interface RunOptions {
  edgeToken: string;
  system: string;
  /** Earlier turns, oldest first. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  question: string;
  /** The console's per-person model choice (validated by the caller); absent means routing decides. */
  pick?: ModelPick;
  ctx?: ToolCtx;
  signal: AbortSignal;
  onText(delta: string): void;
  onTool(e: { name: string; ok: boolean }): void;
  /** Another caller of this loop (the onboarding session): its own purpose (the edge routes and meters by it), tool set and bounds. Absent: the console's. */
  purpose?: "console" | "onboarding";
  toolset?: { defs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>; execute(name: string, input: unknown): Promise<{ text: string; ok: boolean }> };
  maxTokens?: number;
  maxSteps?: number;
}
export interface RunResult { text: string; usage: Usage; model: string | null; stopped: boolean; truncated: boolean }

const MAX_STEPS = 6;

/** The bounded tool loop. Throws ModelUnavailable when no model can answer; an aborted call returns what was said so far, marked stopped. */
export async function runConversation(o: RunOptions): Promise<RunResult> {
  const tools = (o.toolset?.defs ?? offered(o.ctx?.proposeTools ?? new Set<string>())).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const messages: Msg[] = [...o.history.map((h) => ({ role: h.role, content: h.text })), { role: "user", content: o.question }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let model: string | null = null;
  let text = "";
  try {
    for (let step = 0; step < (o.maxSteps ?? MAX_STEPS); step++) {
      const r = await call(o.edgeToken, o.purpose ?? "console", { max_tokens: o.maxTokens ?? 1500, system: o.system, messages, tools }, o.signal, (d) => {
        text += d;
        o.onText(d);
      }, o.pick);
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
      usage.calls++;
      model = r.model ?? model;
      const uses = r.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (r.stopReason !== "tool_use" || !uses.length) return { text: text.trim(), usage, model, stopped: false, truncated: r.stopReason === "max_tokens" };
      messages.push({ role: "assistant", content: r.content });
      const results: Block[] = [];
      for (const u of uses) {
        const out = o.toolset ? await o.toolset.execute(u.name, u.input) : await execute(o.ctx!, u.name, u.input);
        o.onTool({ name: u.name, ok: out.ok });
        results.push({ type: "tool_result", tool_use_id: u.id, content: out.text, ...(out.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
      if (text && !text.endsWith("\n")) {
        text += "\n";
        o.onText("\n");
      }
    }
    return { text: text.trim(), usage, model, stopped: false, truncated: true };
  } catch (e) {
    if (o.signal.aborted) return { text: text.trim(), usage, model, stopped: true, truncated: false };
    throw e;
  }
}

/** One short, tool-less answer: used to explain a policy decision from its trace. */
export async function completeOnce(edgeToken: string, purpose: "explain", system: string, user: string, signal: AbortSignal, onText: (d: string) => void = () => undefined): Promise<{ text: string; usage: Usage; model: string | null }> {
  const r = await call(edgeToken, purpose, { max_tokens: 500, system, messages: [{ role: "user", content: user }] }, signal, onText);
  const text = r.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("").trim();
  return { text, usage: r.usage, model: r.model };
}
