/** Console API calls and queries (services/api/src/routes/console.ts). Query keys start with `console`, the slice name the API publishes on SSE. */
import { useQuery } from "@tanstack/react-query";
import { api, command, del, get, put, streamCommand, post, type ApiResult } from "../../api/client";
import type { Cited, ConsoleStatus, ExplainResult, Proposal, Thread, ThreadSummary, ToolResult } from "./types";

export const ck = {
  status: (project?: string | null) => (project ? (["console", "status", project] as const) : (["console", "status"] as const)),
  threads: () => ["console", "threads"] as const,
  thread: (id: string | null) => ["console", "thread", id] as const,
};

export const useConsoleStatus = (project?: string | null) => useQuery({ queryKey: ck.status(project), queryFn: () => get<ConsoleStatus>(api(`console/status${project ? `?project=${encodeURIComponent(project)}` : ""}`)), staleTime: 15_000 });
/** The person's own model choice; null goes back to the routing default. */
export const setConsoleModel = (model: string | null) => put<{ ok: boolean; msg: string }>(api("console/model"), { model });
export const useThreads = () => useQuery({ queryKey: ck.threads(), queryFn: () => get<{ items: ThreadSummary[]; retentionDays: number }>(api("console/threads")) });
export const useThread = (id: string | null) => useQuery({ queryKey: ck.thread(id), queryFn: () => get<Thread>(api(`console/threads/${encodeURIComponent(id!)}`)), enabled: !!id });

export const callTool = (name: string, input: Record<string, unknown> = {}): Promise<ApiResult<ToolResult>> => post<ToolResult>(api(`console/tools/${encodeURIComponent(name)}`), { input });
export const explain = (o: { person?: string; action: string; project?: string | null; repo?: string | null; time?: number }): Promise<ApiResult<ExplainResult>> => post<ExplainResult>(api("console/explain"), o);
export const clearThread = (id: string) => del(api(`console/threads/${encodeURIComponent(id)}`));
export const savePinned = (id: string, pinned: string[]) => put(api(`console/threads/${encodeURIComponent(id)}/pinned`), { pinned });
export const saveProposal = (messageId: string, p: Proposal, status: "done" | "failed" | "dismissed", result: string) =>
  put(api(`console/messages/${encodeURIComponent(messageId)}/proposals/${encodeURIComponent(p.id)}`), { status, result });

/** Runs a confirmed proposal: the ordinary endpoint, under the person's own authority, with via console. */
export function runProposal(p: Proposal, edits: { reason?: string; confirmText?: string; inFlight?: string }): Promise<ApiResult> {
  const body: Record<string, unknown> = { ...p.call.body };
  if (p.needsReason !== null) body.reason = edits.reason ?? "";
  if (p.phrase) body.confirmText = edits.confirmText ?? "";
  if (p.kind === "kill" && p.call.body.inFlight !== undefined) body.inFlight = edits.inFlight ?? "hold";
  return command(p.call.path, { method: p.call.method, body, idempotent: p.call.idempotent });
}

export type StreamEvent =
  | { event: "thread"; data: { threadId: string; messageId: string; created: boolean } }
  | { event: "text"; data: { delta: string } }
  | { event: "tool"; data: { name: string; ok: boolean } }
  | { event: "proposal"; data: { messageId: string; proposal: Proposal } }
  | { event: "unavailable"; data: { code: string; msg: string; messageId?: string } }
  | { event: "error"; data: { code: string; msg: string; messageId?: string } }
  | { event: "done"; data: { messageId: string; text: string; mode: string; model?: string | null; cited: Cited[]; proposals: Proposal[]; tools?: string[]; stopped?: boolean } };

/** Incremental server-sent-events parser. */
export class SseReader {
  private buf = "";
  push(chunk: string): StreamEvent[] {
    this.buf += chunk;
    const out: StreamEvent[] = [];
    let i: number;
    while ((i = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      try {
        out.push({ event: ev, data: JSON.parse(data) } as StreamEvent);
      } catch {
        /* a broken block is skipped */
      }
    }
    return out;
  }
}

/** POST /console/messages. Resolves when the stream ends: a refusal (403, 404, 422), the JSON of a replayed request, or ok. */
export async function sendMessage(body: { text: string; threadId?: string | null; project?: string | null }, on: (e: StreamEvent) => void, signal: AbortSignal): Promise<ApiResult> {
  const sse = new SseReader();
  let raw = "";
  const r = await streamCommand(api("console/messages"), { ...body, via: "console" }, (chunk) => {
    raw += chunk;
    for (const e of sse.push(chunk)) on(e);
  }, signal, true);
  // A replayed request answers with plain JSON, not a stream.
  if (r.ok && raw.trim().startsWith("{")) {
    try {
      const j = JSON.parse(raw) as { threadId?: string };
      if (j.threadId) on({ event: "thread", data: { threadId: j.threadId, messageId: "", created: false } });
    } catch {
      /* not JSON */
    }
  }
  return r;
}
