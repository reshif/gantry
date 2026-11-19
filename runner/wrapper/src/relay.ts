/**
 * The run token's only home besides the wrapper's own memory.
 *
 * Claude Code's inner sandbox (bubblewrap, which strips credentials from tool subprocesses) cannot start inside the hardened runner container: it needs
 * user namespaces, and the container drops every capability. The container's lockdown stays as it is, so instead nothing secret is handed to the
 * harness at all. The harness and everything it spawns (tool shells, MCP stdio servers) talk to this loopback relay, which adds the run token on the way
 * out: the model gateway, the MCP gateway and research fetch on the edge, and HTTPS tunnels through the edge's forward proxy (Basic `run:<token>`).
 * A subprocess can use the relay (it could use the network anyway) but can never read the token.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";

/** Edge paths a runner may reach through the relay: nothing else is forwarded. */
const ALLOWED = [/^\/model(\/|$|\?)/, /^\/mcp\/v1\//, /^\/run\/v1\/research\/fetch(\?|$)/];

export interface Relay {
  /** `http://127.0.0.1:<port>`: the base URL the harness uses in place of the edge. */
  url: string;
  close(): Promise<void>;
}

export interface RelayOptions {
  edgeUrl: string;
  runToken: string;
  runId: string;
  /** The edge's forward proxy as the container was given it (credentials included). Absent: CONNECT is refused. */
  upstreamProxy?: string | undefined;
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  const edge = new URL(o.edgeUrl);
  const lib = edge.protocol === "https:" ? https : http;
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (!ALLOWED.some((re) => re.test(path))) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, msg: "The runner relay does not forward this path." }));
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: edge.host, authorization: `Bearer ${o.runToken}` };
    delete headers["x-api-key"];
    headers["x-gantry-run-id"] = o.runId;
    const up = lib.request({ protocol: edge.protocol, hostname: edge.hostname, port: edge.port || undefined, method: req.method, path, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, msg: `The edge could not be reached: ${e.message}` }));
    });
    req.pipe(up);
  });

  // HTTPS through the edge's forward proxy: the caller says CONNECT host:port, the relay opens it upstream with the run's Basic credentials.
  server.on("connect", (req, client: net.Socket, head) => {
    const refuse = (code: number): void => void client.end(`HTTP/1.1 ${code} Refused\r\n\r\n`);
    if (!o.upstreamProxy) return refuse(403);
    const px = new URL(o.upstreamProxy);
    const auth = Buffer.from(`run:${o.runToken}`).toString("base64");
    const up = net.connect(Number(px.port || 80), px.hostname, () => {
      up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      up.off("data", onData);
      const ok = /^HTTP\/1\.[01] 200/.test(buf.subarray(0, end).toString("latin1"));
      if (!ok) {
        client.end(buf.subarray(0, end + 4));
        up.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buf.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    };
    up.on("data", onData);
    const drop = (): void => {
      client.destroy();
      up.destroy();
    };
    up.on("error", drop);
    client.on("error", drop);
    client.on("close", () => up.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
