/**
 * The Docker socket proxy: the only process that holds /var/run/docker.sock. The launcher reaches it over a private network
 * (DOCKER_PROXY_URL) and gets only what sockpolicy.ts allows: its own calls, on resources carrying its managed-by label, with
 * container, network and volume creates checked against the runner template. A refusal is a 403 with the reason, logged.
 *
 * Env: SOCKPROXY_PORT (2375), DOCKER_SOCKET (/var/run/docker.sock), RUNNER_VARIANTS (the allowed images, as the launcher reads
 * them), EDGE_COMPOSE_SERVICE (gantry-edge: the only container that may be connected to a run network).
 */
import http from "node:http";
import { checkConnect, checkContainer, checkNetwork, checkVolume, managed, route, type Decision } from "./sockpolicy.js";

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const PORT = Number(process.env.SOCKPROXY_PORT || 2375);
const EDGE_SERVICE = process.env.EDGE_COMPOSE_SERVICE || "gantry-edge";
const MAX_BODY = 256 * 1024;
const images = new Set(
  (process.env.RUNNER_VARIANTS || "base=gantry-runner:dev")
    .split(",")
    .map((p) => p.split("=")[1]?.trim())
    .filter((x): x is string => !!x),
);

/** A GET against the real socket, for the ownership checks. */
function inspect(path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const r = http.request({ socketPath: SOCKET, path, method: "GET" }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (buf += c));
      res.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(buf) as Record<string, unknown>;
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    r.on("error", () => resolve({ status: 0, body: null }));
    r.end();
  });
}

const labelsOf = (kind: "container" | "network" | "volume", b: Record<string, unknown> | null): Record<string, string> | null => {
  if (!b) return null;
  if (kind === "container") return ((b.Config as { Labels?: Record<string, string> } | undefined)?.Labels ?? null);
  return (b.Labels as Record<string, string> | undefined) ?? null;
};

async function ownedBy(kind: "container" | "network" | "volume", id: string): Promise<Decision | "missing"> {
  const path = kind === "container" ? `/containers/${encodeURIComponent(id)}/json` : kind === "network" ? `/networks/${encodeURIComponent(id)}` : `/volumes/${encodeURIComponent(id)}`;
  const r = await inspect(path);
  if (r.status === 404) return "missing"; // let Docker answer 404 itself
  if (r.status !== 200) return { ok: false, why: `Could not check who owns ${kind} ${id}.` };
  return managed(labelsOf(kind, r.body)) ? { ok: true } : { ok: false, why: `${kind} ${id} is not managed by the launcher.` };
}

async function isEdge(container: string): Promise<boolean> {
  const r = await inspect(`/containers/${encodeURIComponent(container)}/json`);
  const labels = labelsOf("container", r.body);
  return r.status === 200 && !!labels && labels["com.docker.compose.service"] === EDGE_SERVICE;
}

function refuse(res: http.ServerResponse, method: string, url: string, why: string): void {
  console.warn(JSON.stringify({ at: new Date().toISOString(), msg: "sockproxy refused", method, url: url.slice(0, 300), why }));
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `Refused by the Gantry socket proxy: ${why}` }));
}

function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer | null): void {
  const headers = { ...req.headers };
  delete headers.host;
  if (body) {
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
  }
  const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `docker socket: ${e.message}` }));
  });
  if (body) up.end(body);
  else req.pipe(up);
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        req.destroy();
        resolve(null);
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

export function createProxy(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const r = route(method, url);
      if (!r.decision.ok) return refuse(res, method, url, r.decision.why);
      if (r.owned) {
        const own = await ownedBy(r.owned.kind, r.owned.id);
        if (own !== "missing" && !own.ok) return refuse(res, method, url, own.why);
      }
      if (!r.body) return forward(req, res, null);
      const raw = await readBody(req);
      if (!raw) return refuse(res, method, url, "The body is too large or could not be read.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return refuse(res, method, url, "The body is not valid JSON.");
      }
      const q = new URLSearchParams(url.split("?")[1] ?? "");
      const d =
        r.body === "container" ? checkContainer(parsed, q, images)
        : r.body === "network" ? checkNetwork(parsed)
        : r.body === "volume" ? checkVolume(parsed)
        : checkConnect(parsed);
      if (!d.ok) return refuse(res, method, url, d.why);
      if (r.body === "connect" && !(await isEdge(String((parsed as { Container: string }).Container)))) return refuse(res, method, url, "Only the edge may be connected to a run network.");
      forward(req, res, raw);
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: e instanceof Error ? e.message : "proxy error" }));
    });
  });
}

if (process.argv[1]?.endsWith("sockproxy.js")) {
  const server = createProxy();
  server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "sockproxy listening", port: PORT, images: [...images] })));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
