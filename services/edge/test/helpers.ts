import http from "node:http";
import type { AddressInfo } from "node:net";
import type { EdgeConfig } from "../src/config.js";

export const listen = (s: http.Server): Promise<number> => new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
export const close = (s: http.Server): Promise<void> => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });

export const makeToken = (runId: string): string => `grt.${Buffer.from(runId).toString("base64url")}.${"a".repeat(43)}`;

export const baseConfig = (o: Partial<EdgeConfig> = {}): EdgeConfig => ({
  apiUrl: "http://127.0.0.1:1",
  edgeToken: "edge-token-for-tests",
  vendorKeys: { "w3-anthropic": "sk-ant-test-vendor-key-0123456789abcdef" },
  modelPort: 0,
  proxyPort: 0,
  s3: null,
  vendorConcurrency: 4,
  queueWaitMs: 500,
  apiTimeoutMs: 1000,
  vendorTimeoutMs: 5000,
  allowlistTtlMs: 200,
  tunnelCheckMs: 0,
  runSubnet: "10.213.0.0/16",
  allowedPorts: [80, 443],
  blockPrivateAddresses: false,
  maxBodyBytes: 1_000_000,
  maxTraceBytes: 1_000_000,
  ...o,
});

export interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** A fake control-plane API: answers like the real /internal/v1 (shapes pinned by services/api/test/internal-runs.test.ts). */
export class FakeApi {
  server = http.createServer((req, res) => void this.handle(req, res));
  port = 0;
  calls: Recorded[] = [];
  /** Per-path overrides: return [status, body] to answer. */
  override: ((r: Recorded) => [number, unknown] | undefined) | undefined;
  allow = true;
  denial = { code: "stopped", reason: "Halted at wo scope." };
  route = { vendor: "w3-anthropic", baseUrl: "", modelId: "claude-test-1" };
  hosts: string[] = ["registry.npmjs.org", "*.allowed.example", "127.0.0.1"];
  systemHosts: string[] = ["hooks.slack.com"];
  down = false;

  async start(): Promise<void> {
    this.port = await listen(this.server);
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  of(suffix: string): Recorded[] {
    return this.calls.filter((c) => c.url.endsWith(suffix));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    this.calls.push(rec);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (this.down) return void res.destroy();
    if (req.headers.authorization !== "Bearer edge-token-for-tests") return send(401, { ok: false, msg: "no" });
    const o = this.override?.(rec);
    if (o) return send(o[0], o[1]);
    if (rec.url.endsWith("/authorize")) {
      return send(200, this.allow ? { ok: true, msg: "Allowed.", allow: true, reason: "ok", route: this.route } : { ok: true, msg: this.denial.reason, allow: false, code: this.denial.code, reason: this.denial.reason });
    }
    if (rec.url.endsWith("/egress")) return send(200, { ok: true, projectId: "payments", hosts: this.hosts });
    if (rec.url.endsWith("/egress/system")) return send(200, { ok: true, hosts: this.systemHosts });
    if (rec.url.includes("/vendors/")) return send(404, { ok: false, msg: "no key" });
    if (rec.url.endsWith("/spec")) return send(200, { runId: "r", adapter: "stub", station: "build" });
    return send(200, { ok: true, msg: "ok" });
  }
}

/** A fake model vendor speaking the Messages API (JSON and SSE). */
export class FakeVendor {
  server = http.createServer((req, res) => void this.handle(req, res));
  port = 0;
  calls: Recorded[] = [];
  /** Next responses to force (status, headers). */
  force: Array<{ status: number; headers?: Record<string, string>; body?: unknown }> = [];
  active = 0;
  maxActive = 0;
  delayMs = 0;
  leakKey: string | undefined;

  async start(): Promise<void> {
    this.port = await listen(this.server);
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    this.calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const f = this.force.shift();
      if (f) {
        res.writeHead(f.status, { "content-type": "application/json", ...(f.headers ?? {}) });
        return void res.end(JSON.stringify(f.body ?? { type: "error", error: { type: "overloaded_error", message: "busy" } }));
      }
      const j = JSON.parse(body) as { stream?: boolean; model?: string };
      const text = this.leakKey ? `here is a key ${this.leakKey} oops` : "Hello world";
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_vendor_1" });
        const ev = (t: string, d: unknown): string => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
        res.write(ev("message_start", { type: "message_start", message: { id: "msg_1", model: j.model, usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } }));
        res.write(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        const mid = Math.floor(text.length / 2);
        res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, mid) } }));
        await new Promise((r) => setTimeout(r, 20));
        res.write(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(mid) } }));
        res.write(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.write(ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }));
        res.end(ev("message_stop", { type: "message_stop" }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_vendor_2" });
        res.end(JSON.stringify({ id: "msg_2", type: "message", model: j.model, content: [{ type: "text", text }], usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }));
      }
    } finally {
      this.active--;
    }
  }
}

/** A path-style S3 double (PUT/HEAD/GET object). Only for tests. */
export class FakeS3 {
  objects = new Map<string, Buffer>();
  down = false;
  server = http.createServer((req, res) => void this.handle(req, res));
  port = 0;
  async start(): Promise<void> {
    this.port = await listen(this.server);
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (this.down) return void res.destroy();
    const key = decodeURIComponent((req.url ?? "").split("?")[0]!);
    if (req.method === "PUT") {
      this.objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"x"' });
      return void res.end();
    }
    const o = this.objects.get(key);
    if (!o) {
      res.writeHead(404);
      return void res.end();
    }
    res.writeHead(200, { "content-length": String(o.length) });
    res.end(req.method === "HEAD" ? undefined : o);
  }
}
