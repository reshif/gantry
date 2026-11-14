import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: any;
}

export interface FakeEdge {
  url: string;
  calls: Recorded[];
  close(): Promise<void>;
  /** Make heartbeats return this status from now on. */
  heartbeatStatus: number;
}

/** A real HTTP server standing in for the edge's /run/v1 surface. */
export async function startFakeEdge(spec: unknown, token: string): Promise<FakeEdge> {
  const calls: Recorded[] = [];
  const state = { heartbeatStatus: 200 };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (d) => (s += d));
      req.on("end", () => resolve(s));
    });
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = req.url ?? "";
    const rec: Recorded = { method: req.method ?? "", path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
    calls.push(rec);
    if (rec.auth !== `Bearer ${token}`) return void res.writeHead(401).end();
    if (path === "/run/v1/spec") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(spec));
    if (path === "/run/v1/heartbeat" && state.heartbeatStatus !== 200) return void res.writeHead(state.heartbeatStatus).end();
    return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get heartbeatStatus() {
      return state.heartbeatStatus;
    },
    set heartbeatStatus(v: number) {
      state.heartbeatStatus = v;
    },
  };
}
