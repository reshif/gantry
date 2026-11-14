/** A stand-in for the Gantry API's internal endpoints the broker calls (test/ only). */
import { createServer, type Server } from "node:http";

export interface ApiCall { method: string; path: string; body: any; auth: string }
export type FenceRule = (c: ApiCall, n: number) => { allow: boolean; code?: string; reason?: string; woId?: string; branch?: string; repo?: string };

export class FakeApi {
  readonly calls: ApiCall[] = [];
  readonly token = "gh-broker-token";
  url = "";
  server!: Server;
  fence: FenceRule = (c) => ({ allow: true, woId: "WO-1", branch: "gantry/WO-1", repo: "acme/payments-api", ...(c.body?.purpose ? {} : {}) });
  factsStatus = 200;
  onboardingFence: (c: ApiCall) => { allow: boolean; code?: string; reason?: string } = () => ({ allow: true });
  repos: any[] = [];
  private fenceCount = 0;

  facts(): any[] { return this.calls.filter((c) => c.path === "/internal/v1/github/events").map((c) => c.body); }
  fences(): ApiCall[] { return this.calls.filter((c) => /fence-check$/.test(c.path)); }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const call: ApiCall = { method: req.method ?? "GET", path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined, auth: String(req.headers.authorization ?? "") };
        this.calls.push(call);
        res.setHeader("content-type", "application/json");
        if (call.auth !== `Bearer ${this.token}`) { res.statusCode = 401; return void res.end(JSON.stringify({ ok: false })); }
        if (/fence-check$/.test(call.path)) { try { res.end(JSON.stringify({ ok: true, ...this.fence(call, ++this.fenceCount) })); } catch { res.statusCode = 500; res.end("{}"); } return; }
        if (call.path === "/internal/v1/onboarding/fence") { res.end(JSON.stringify({ ok: true, ...this.onboardingFence(call) })); return; }
        if (call.path === "/internal/v1/github/events") { res.statusCode = this.factsStatus; res.end(JSON.stringify(this.factsStatus === 200 ? { ok: true, counts: { drift: 0 }, merged: [] } : { ok: false })); return; }
        if (call.path === "/internal/v1/github/repos") { res.end(JSON.stringify({ ok: true, repos: this.repos })); return; }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
}
