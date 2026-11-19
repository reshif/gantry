/** Test doubles for the notification tests: a Slack Web API server and a webhook receiver. Test code only; nothing here ships. */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: string; json: Record<string, any> | null }

export class Double {
  readonly seen: Seen[] = [];
  server!: http.Server;
  port = 0;
  /** path -> handler returning [status, body]. */
  routes = new Map<string, (s: Seen) => [number, unknown]>();

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, any> | null = null;
        try {
          json = JSON.parse(body) as Record<string, any>;
        } catch {
          /* not json */
        }
        const s: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, json };
        this.seen.push(s);
        const h = this.routes.get(s.path.split("?")[0]!);
        const [status, out] = h ? h(s) : [404, { ok: false, error: "unknown_method" }];
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof out === "string" ? out : JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  on(path: string, h: (s: Seen) => [number, unknown]): this {
    this.routes.set(path, h);
    return this;
  }
  calls(path: string): Seen[] {
    return this.seen.filter((s) => s.path.split("?")[0] === path);
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A Slack that knows one bot token. Fake credential-shaped strings are assembled at runtime (push protection). */
export const fakeBotToken = (): string => "xoxb" + "-" + "1".repeat(12) + "-" + "a".repeat(24);
export const fakeSigningSecret = (): string => "sgn" + "a1b2c3d4e5f60718".repeat(2);

export async function slackDouble(token = fakeBotToken()): Promise<Double> {
  const d = await new Double().start();
  let n = 0;
  const authed = (s: Seen): boolean => s.headers.authorization === `Bearer ${token}`;
  d.on("/api/auth.test", (s) => (authed(s) ? [200, { ok: true, user: "gantry", team: "Acme", user_id: "UBOT" }] : [200, { ok: false, error: "invalid_auth" }]));
  d.on("/api/chat.postMessage", (s) => {
    if (!authed(s)) return [200, { ok: false, error: "invalid_auth" }];
    if (s.json?.channel === "#nope") return [200, { ok: false, error: "channel_not_found" }];
    if (s.json?.channel === "#slow") return [200, { ok: false, error: "ratelimited" }];
    n += 1;
    return [200, { ok: true, channel: "C0123", ts: `1700000000.${String(n).padStart(6, "0")}`, message: { text: s.json?.text } }];
  });
  d.on("/api/chat.update", (s) => (authed(s) ? [200, { ok: true, channel: s.json?.channel, ts: s.json?.ts }] : [200, { ok: false, error: "invalid_auth" }]));
  d.on("/respond", () => [200, { ok: true }]);
  return d;
}
