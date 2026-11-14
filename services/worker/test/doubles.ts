/**
 * Test doubles for the services the worker talks to. They live under test/ only: nothing here is wired into the product.
 * Each is a real HTTP (or SMTP) server on an ephemeral port, so the worker's real clients are what the tests exercise.
 */
import { createServer as netServer, connect as netConnect, type Server as NetServer, type Socket } from "node:net";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

export interface Call { op: string; at: number; body?: Record<string, any>; query?: string; [k: string]: unknown }

async function listen(server: http.Server | https.Server | NetServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}
const close = (s: http.Server | https.Server | NetServer): Promise<void> => new Promise((r) => { (s as http.Server).closeAllConnections?.(); s.close(() => r()); });

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------------------------------ launcher */

export interface FakeRun { runId: string; state: "prepared" | "started"; runToken: string; workspaceRef: string; variant: string; keepWorkspace?: boolean }

export class FakeLauncher {
  readonly token = "launcher-test-token";
  runs = new Map<string, FakeRun>();
  calls: Call[] = [];
  /** Answer 429 to start-run (the launcher is full). */
  capacity = false;
  /** Runs that survive stop-run (a container that will not die). */
  stuck = new Set<string>();
  /** Fail this many stop-run calls with teardown_incomplete. */
  stopFailures = 0;
  /** Runs the double lists although nobody started them (orphans left by a crash). */
  onStop: ((id: string) => void | Promise<void>) | null = null;
  onStart: ((r: Record<string, any>) => void | Promise<void>) | null = null;
  private server!: http.Server;
  url = "";

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => send(res, 500, { ok: false, msg: String(e) })));
    this.url = `http://127.0.0.1:${await listen(this.server)}`;
    return this;
  }
  stop(): Promise<void> { return close(this.server); }

  addOrphan(runId: string): void {
    this.runs.set(runId, { runId, state: "started", runToken: "orphan", workspaceRef: "orphan", variant: "base" });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(res, 401, { ok: false, msg: "unauthorized" });
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/v1/runs") {
      const b = await readJson(req);
      this.calls.push({ op: "start", at: Date.now(), body: b });
      await this.onStart?.(b);
      const allowed = new Set(["runId", "workspaceRef", "variant", "runToken", "seedComplete"]);
      if (Object.keys(b).some((k) => !allowed.has(k))) return send(res, 422, { ok: false, msg: "invalid request" });
      if (this.capacity) return send(res, 429, { ok: false, kind: "capacity", msg: "at capacity" });
      const have = this.runs.get(b.runId);
      if (have?.state === "started") return send(res, 200, { ok: true, runId: b.runId, state: "running" });
      const state = b.seedComplete === false ? "prepared" : "started";
      this.runs.set(b.runId, { runId: b.runId, state, runToken: b.runToken, workspaceRef: b.workspaceRef, variant: b.variant });
      return send(res, 201, { ok: true, runId: b.runId, state, network: `run-${b.runId}`, volume: `ws-${b.runId}` });
    }
    if (req.method === "DELETE" && u.pathname.startsWith("/v1/runs/")) {
      const id = decodeURIComponent(u.pathname.slice("/v1/runs/".length));
      this.calls.push({ op: "stop", at: Date.now(), runId: id, keepWorkspace: u.searchParams.get("keepWorkspace") });
      await this.onStop?.(id);
      if (this.stopFailures > 0) {
        this.stopFailures--;
        return send(res, 500, { ok: false, kind: "teardown_incomplete", msg: "teardown incomplete" });
      }
      const found = this.runs.has(id);
      if (!this.stuck.has(id)) this.runs.delete(id);
      return send(res, 200, { ok: true, runId: id, found, errors: [] });
    }
    if (req.method === "GET" && u.pathname === "/v1/runs") {
      this.calls.push({ op: "list", at: Date.now() });
      return send(res, 200, { ok: true, runs: [...this.runs.values()].map((r) => ({ runId: r.runId, variant: r.variant, workspaceRef: r.workspaceRef, container: r.state === "started" ? { id: `c-${r.runId}` } : null, network: { name: `run-${r.runId}` }, volume: { name: `ws-${r.runId}` } })), capacity: { max: 32, networks: this.runs.size } });
    }
    send(res, 404, { ok: false, msg: "not found" });
  }
}

/* ------------------------------------------------------------------------------------------ github broker */

export interface FakePr { number: number; state: "open" | "closed" | "merged"; head: string; draft: boolean; mergeSha: string | null }

export class FakeBroker {
  readonly token = "github-test-token";
  calls: Call[] = [];
  prs = new Map<number, FakePr>();
  /** Actual merges performed on GitHub (what F4 counts). */
  merges: Array<{ number: number; sha: string }> = [];
  /** Perform the merge, then cut the connection before the answer: the worker crashes between the call and its commit. */
  dropAfterMerge = 0;
  failSeed = 0;
  publishResponse: Record<string, any> | { status: number; body: Record<string, any> } | null = null;
  mergeResponse: { status: number; body: Record<string, any> } | null = null;
  gateCheckStatus = 200;
  onPublish: ((b: Record<string, any>) => void | Promise<void>) | null = null;
  private server!: http.Server;
  url = "";

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => send(res, 500, { ok: false, msg: String(e) })));
    this.url = `http://127.0.0.1:${await listen(this.server)}`;
    return this;
  }
  stop(): Promise<void> { return close(this.server); }
  count(op: string): number { return this.calls.filter((c) => c.op === op).length; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(res, 401, { ok: false, msg: "A service token is required." });
    const u = new URL(req.url ?? "/", "http://x");
    const b = req.method === "POST" ? await readJson(req) : {};
    const path = u.pathname;
    if (path === "/v1/workspaces/seed") {
      this.calls.push({ op: "seed", at: Date.now(), body: b });
      if (this.failSeed > 0) { this.failSeed--; return send(res, 502, { ok: false, code: "fetch_failed", msg: "GitHub is down" }); }
      return send(res, 200, { ok: true, ...b });
    }
    if (path === "/v1/publish") {
      this.calls.push({ op: "publish", at: Date.now(), body: b });
      await this.onPublish?.(b);
      const r = this.publishResponse;
      if (r && "status" in r) return send(res, r.status as number, r.body);
      return send(res, 200, r ?? { ok: true, branch: b.branch, headSha: "a".repeat(40), noop: false, alreadyPublished: false, commits: [{ localSha: "b".repeat(40), sha: "a".repeat(40) }], pullRequest: { number: 7, url: "http://gh/pr/7", created: true } });
    }
    if (path === "/v1/checks/gate") {
      this.calls.push({ op: "check", at: Date.now(), body: b });
      return this.gateCheckStatus === 200 ? send(res, 200, { ok: true }) : send(res, this.gateCheckStatus, { ok: false, code: this.gateCheckStatus === 409 ? "fenced" : "boom", msg: "refused" });
    }
    if (path === "/v1/pulls/draft") {
      this.calls.push({ op: "draft", at: Date.now(), body: b });
      const pr = this.prs.get(b.number);
      if (pr) pr.draft = true;
      return send(res, 200, { ok: true, draft: true, alreadyDraft: false });
    }
    if (path === "/v1/pull-state") {
      const n = Number(u.searchParams.get("number"));
      this.calls.push({ op: "pull-state", at: Date.now(), query: u.search });
      const pr = this.prs.get(n);
      if (!pr) return send(res, 404, { ok: false, code: "not_found", msg: "no such pull request" });
      return send(res, 200, { ok: true, pullRequest: { number: n, state: pr.state, draft: pr.draft, headSha: pr.head, mergeCommitSha: pr.mergeSha, mergedAt: pr.state === "merged" ? new Date().toISOString() : null }, checks: [], reviews: [], approvals: [], status: null, mergeable: true, mergeableState: "clean" });
    }
    if (path === "/v1/pulls/merge") {
      this.calls.push({ op: "merge", at: Date.now(), body: b });
      if (this.mergeResponse) return send(res, this.mergeResponse.status, this.mergeResponse.body);
      const pr = this.prs.get(b.number);
      if (!pr) return send(res, 404, { ok: false, code: "not_found", msg: "no such pull request" });
      if (pr.state === "merged") return send(res, 200, { ok: true, merged: true, mergeSha: pr.mergeSha, alreadyMerged: true });
      if (pr.head !== b.headSha) return send(res, 409, { ok: false, code: "head_moved", msg: "head moved", headSha: pr.head });
      pr.state = "merged";
      pr.mergeSha = "c".repeat(40);
      this.merges.push({ number: b.number, sha: b.headSha });
      if (this.dropAfterMerge > 0) { this.dropAfterMerge--; req.socket.destroy(); return; }
      return send(res, 200, { ok: true, merged: true, mergeSha: pr.mergeSha, alreadyMerged: false });
    }
    if (path === "/v1/reconcile") {
      this.calls.push({ op: "reconcile", at: Date.now(), body: b });
      return send(res, 200, { ok: true, repo: b.repo, pullRequests: 0 });
    }
    send(res, 404, { ok: false, msg: "not found" });
  }
}

/* ------------------------------------------------------------------------------------------ webhook receiver */

export interface Received { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** An HTTP or HTTPS endpoint that records what it gets and answers with the next queued status (200 when the queue is empty). */
export class FakeEndpoint {
  received: Received[] = [];
  statuses: number[] = [];
  private server!: http.Server | https.Server;
  port = 0;

  async start(tls?: { key: string; cert: string }): Promise<this> {
    const h = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        const status = this.statuses.shift() ?? 200;
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(status === 200 ? "ok" : "no");
      });
    };
    this.server = tls ? https.createServer(tls, h) : http.createServer(h);
    this.port = await listen(this.server);
    return this;
  }
  stop(): Promise<void> { return close(this.server); }
}

/* ------------------------------------------------------------------------------------------ forward proxy */

/** A forward proxy shaped like the edge's :8444: CONNECT for HTTPS, absolute-URI for plain HTTP. Records what it was asked for. */
export class FakeProxy {
  connects: string[] = [];
  private sockets = new Set<Socket>();
  absolute: string[] = [];
  refuse = new Set<string>();
  private server!: http.Server;
  port = 0;

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const target = req.url ?? "";
      this.absolute.push(`${req.method} ${target}`);
      const u = new URL(target);
      if (this.refuse.has(u.hostname)) { res.writeHead(403); return void res.end("not allow-listed"); }
      const up = http.request({ host: u.hostname, port: Number(u.port || 80), method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(up);
    });
    this.server.on("connect", (req: http.IncomingMessage, client: Socket, head: Buffer) => {
      const [host, port] = (req.url ?? "").split(":");
      this.connects.push(req.url ?? "");
      this.sockets.add(client);
      client.on("close", () => this.sockets.delete(client));
      if (this.refuse.has(host ?? "")) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const up = netConnect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      client.on("error", () => up.destroy());
      client.on("close", () => up.destroy());
      up.on("close", () => client.destroy());
    });
    this.port = await listen(this.server);
    return this;
  }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  stop(): Promise<void> { this.sockets.forEach((s) => s.destroy()); return close(this.server); }
}

/* ------------------------------------------------------------------------------------------ smtp */

export interface Mail { from: string; to: string[]; data: string }

/** Just enough SMTP for nodemailer: EHLO, MAIL, RCPT, DATA, QUIT. Like mailpit, it keeps what it receives. */
export class FakeSmtp {
  mails: Mail[] = [];
  /** Answer the next N DATA commands with a 451 (temporary failure) before accepting. */
  tempFail = 0;
  /** Reject all recipients with a 550. */
  rejectAll = false;
  port = 0;
  private server!: NetServer;

  async start(): Promise<this> {
    this.server = netServer((sock) => {
      sock.setEncoding("utf8");
      let cur: Mail = { from: "", to: [], data: "" };
      let data = false;
      let buf = "";
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          if (data) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            cur.data = buf.slice(0, end);
            buf = buf.slice(end + 5);
            data = false;
            if (this.tempFail > 0) { this.tempFail--; sock.write("451 try again later\r\n"); }
            else { this.mails.push(cur); sock.write("250 queued\r\n"); }
            cur = { from: "", to: [], data: "" };
            continue;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250-fake\r\n250 8BITMIME\r\n");
          else if (cmd === "MAIL") { cur.from = line.slice(10); sock.write("250 ok\r\n"); }
          else if (cmd === "RCPT") { if (this.rejectAll) sock.write("550 no such user\r\n"); else { cur.to.push(line.slice(8)); sock.write("250 ok\r\n"); } }
          else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
          else if (cmd === "RSET") sock.write("250 ok\r\n");
          else if (cmd === "QUIT") { sock.end("221 bye\r\n"); return; }
          else sock.write("250 ok\r\n");
        }
      });
      sock.on("error", () => undefined);
    });
    this.port = await listen(this.server);
    return this;
  }
  stop(): Promise<void> { return close(this.server); }
}
