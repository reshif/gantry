import http from "node:http";
import type { AddressInfo } from "node:net";

export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export interface Turn { blocks: Block[]; stop?: "end_turn" | "tool_use" | "max_tokens"; status?: number; error?: { type: string; message: string }; delayMs?: number }

/** A test double for the edge's service gateway (`/service/v1/*`): answers from a script, in the Anthropic streaming format. Only for tests. */
export class FakeEdge {
  server = http.createServer((req, res) => void this.handle(req, res));
  url = "";
  ready: { ready: boolean; code?: string; reason?: string; vendor?: string; model?: string } = { ready: true, vendor: "anthropic", model: "claude-test-1" };
  /** Every /ready request URL (with its query: the chosen model and project). */
  readyUrls: string[] = [];
  script: Turn[] = [];
  /** Stored traces by sha256 hex (what the edge's `GET /service/v1/trace/{hash}` serves). */
  traces = new Map<string, unknown>();
  calls: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  /** Consulted when the script is empty (the live harness answers by what was asked). */
  respond: ((body: Record<string, unknown>) => Turn | undefined) | undefined;

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset(): void {
    this.script = [];
    this.calls = [];
    this.readyUrls = [];
    this.ready = { ready: true, vendor: "anthropic", model: "claude-test-1" };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.headers.authorization !== "Bearer edge-token-for-tests") {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ ok: false }));
    }
    const tm = /^\/service\/v1\/trace\/([0-9a-f]{64})$/.exec(req.url ?? "");
    if (tm) {
      const t = this.traces.get(tm[1]!);
      res.writeHead(t ? 200 : 404, { "content-type": "application/json" });
      return void res.end(JSON.stringify(t ?? { ok: false }));
    }
    if ((req.url ?? "").split("?")[0] === "/service/v1/ready") {
      this.readyUrls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(this.ready));
    }
    this.calls.push({ url: req.url ?? "", headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    const turn = this.script.shift() ?? this.respond?.(this.calls.at(-1)!.body);
    if (!turn) {
      res.writeHead(500, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "the script ran out" } }));
    }
    if (turn.status && turn.status !== 200) {
      res.writeHead(turn.status, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ type: "error", error: turn.error ?? { type: "api_error", message: "boom" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "x-gantry-model": "claude-test-1" });
    const ev = (t: string, d: unknown): string => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...(d as object) })}\n\n`;
    res.write(ev("message_start", { message: { id: "msg_1", usage: { input_tokens: 100, output_tokens: 1 } } }));
    let i = 0;
    for (const b of turn.blocks) {
      if (b.type === "text") {
        res.write(ev("content_block_start", { index: i, content_block: { type: "text", text: "" } }));
        const mid = Math.max(1, Math.floor(b.text.length / 2));
        res.write(ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text.slice(0, mid) } }));
        if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
        res.write(ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text.slice(mid) } }));
      } else {
        res.write(ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }));
        const j = JSON.stringify(b.input);
        res.write(ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: j.slice(0, 5) } }));
        res.write(ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: j.slice(5) } }));
      }
      res.write(ev("content_block_stop", { index: i }));
      i++;
    }
    res.write(ev("message_delta", { delta: { stop_reason: turn.stop ?? (turn.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") }, usage: { output_tokens: 40 } }));
    res.end(ev("message_stop", {}));
  }
}

/** Parses a server-sent-events body into [{event, data}]. */
export function parseSse(body: string): Array<{ event: string; data: any }> {
  return body.split(/\n\n/).filter((b) => b.trim()).map((b) => {
    const event = /^event: (.*)$/m.exec(b)?.[1] ?? "";
    const data = /^data: (.*)$/m.exec(b)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}
