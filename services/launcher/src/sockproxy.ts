/**
 * The Docker socket proxy: the only process that holds /var/run/docker.sock. The launcher reaches it over a private network
 * (DOCKER_PROXY_URL) and gets only what sockpolicy.ts allows: its own calls, on resources carrying its managed-by label, with
 * container, network and volume creates checked against the runner template. A refusal is a 403 with the reason, logged.
 *
 * A second profile (SOCKPROXY_PROFILE=workspace, run as its own container) serves gantry-github, which seeds and reads ws-<id>
 * volumes through a never-started helper container: it allows only the helper's create, its two archive calls, its removal and a
 * volume inspect, each on resources carrying the right labels. Neither profile can start, exec, attach, pull or build.
 *
 * Env: SOCKPROXY_PORT (2375; 2376 for the workspace profile), SOCKPROXY_PROFILE (launcher | workspace), DOCKER_SOCKET
 * (/var/run/docker.sock), RUNNER_VARIANTS (the allowed images, as the launcher reads them), EDGE_COMPOSE_SERVICE (gantry-edge: the
 * only container that may be connected to a run network), EDGE_COMPOSE_PROJECT, RUNNER_UID, RUNNER_MEMORY_MB, RUNNER_PIDS and
 * RUNNER_CPUS (ceilings a runner create must state and stay under), GITHUB_HELPER_IMAGE (workspace profile).
 */
import http from "node:http";
import { checkConnect, checkContainer, checkHelperCreate, checkList, checkNetwork, checkVolume, isHelper, managed, route, routeWorkspace, slimNetworks, type Decision, type RunnerLimits } from "./sockpolicy.js";
import { LABEL_MANAGED } from "./template.js";

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const PROFILE = process.env.SOCKPROXY_PROFILE === "workspace" ? "workspace" : "launcher";
const PORT = Number(process.env.SOCKPROXY_PORT || (PROFILE === "workspace" ? 2376 : 2375));
const EDGE_SERVICE = process.env.EDGE_COMPOSE_SERVICE || "gantry-edge";
const EDGE_PROJECT = process.env.EDGE_COMPOSE_PROJECT || "";
const HELPER_IMAGE = process.env.GITHUB_HELPER_IMAGE || "gantry-github:dev";
const uid = Number(process.env.RUNNER_UID || 10001);
const limits: RunnerLimits = {
  uid,
  gid: uid,
  memoryBytes: Number(process.env.RUNNER_MEMORY_MB || 4096) * 1024 * 1024,
  pids: Number(process.env.RUNNER_PIDS || 512),
  nanoCpus: Math.round(Number(process.env.RUNNER_CPUS || 2) * 1e9),
};
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

async function ownedBy(kind: "container" | "network" | "volume" | "helper", id: string, edgeOk = false): Promise<Decision | "missing"> {
  if (kind === "helper") {
    const r = await inspect(`/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return "missing";
    if (r.status !== 200) return { ok: false, why: `Could not check who owns container ${id}.` };
    return isHelper(labelsOf("container", r.body)) ? { ok: true } : { ok: false, why: `container ${id} is not a workspace helper.` };
  }
  const path = kind === "container" ? `/containers/${encodeURIComponent(id)}/json` : kind === "network" ? `/networks/${encodeURIComponent(id)}` : `/volumes/${encodeURIComponent(id)}`;
  const r = await inspect(path);
  if (r.status === 404) return "missing"; // let Docker answer 404 itself
  if (r.status !== 200) return { ok: false, why: `Could not check who owns ${kind} ${id}.` };
  if (managed(labelsOf(kind, r.body))) return { ok: true };
  if (edgeOk && kind === "container" && edgeLabels(labelsOf("container", r.body))) return { ok: true };
  return { ok: false, why: `${kind} ${id} is not managed by the launcher.` };
}

/**
 * The edge is recognised by its compose service and project labels, and only if it is not a container created through this proxy (a
 * runner the launcher made carries gantry.managed-by, so a spoofed compose label on a runner cannot pass).
 */
function edgeLabels(labels: Record<string, string> | null): boolean {
  if (!labels || labels["com.docker.compose.service"] !== EDGE_SERVICE) return false;
  if (EDGE_PROJECT && labels["com.docker.compose.project"] !== EDGE_PROJECT) return false;
  return labels[LABEL_MANAGED] === undefined;
}

async function isEdge(container: string): Promise<boolean> {
  const r = await inspect(`/containers/${encodeURIComponent(container)}/json`);
  return r.status === 200 && edgeLabels(labelsOf("container", r.body));
}

function refuse(res: http.ServerResponse, method: string, url: string, why: string): void {
  console.warn(JSON.stringify({ at: new Date().toISOString(), msg: "sockproxy refused", method, url: url.slice(0, 300), why }));
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `Refused by the Gantry socket proxy: ${why}` }));
}

function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer | null, transform?: (parsed: unknown) => unknown): void {
  const headers = { ...req.headers };
  delete headers.host;
  if (body) {
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
  }
  const up = http.request({ socketPath: SOCKET, path: req.url, method: req.method, headers }, (ur) => {
    if (transform && ur.statusCode === 200) {
      const chunks: Buffer[] = [];
      ur.on("data", (c: Buffer) => chunks.push(c));
      ur.on("end", () => {
        let out: Buffer;
        try {
          out = Buffer.from(JSON.stringify(transform(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
        } catch {
          out = Buffer.from("[]");
        }
        const h = { ...ur.headers, "content-length": String(out.length) };
        delete h["transfer-encoding"];
        res.writeHead(200, h);
        res.end(out);
      });
      return;
    }
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

function fail(res: http.ServerResponse, e: unknown): void {
  if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: e instanceof Error ? e.message : "proxy error" }));
}

async function parseBody(req: http.IncomingMessage, res: http.ServerResponse, method: string, url: string): Promise<unknown | undefined> {
  const raw = await readBody(req);
  if (!raw) return void refuse(res, method, url, "The body is too large or could not be read.");
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8") || "{}") as unknown };
  } catch {
    return void refuse(res, method, url, "The body is not valid JSON.");
  }
}

/** The workspace profile: the broker's helper container and archive calls, nothing else. */
function workspaceHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const r = routeWorkspace(method, url);
    if (!r.decision.ok) return refuse(res, method, url, r.decision.why);
    if (r.owned) {
      let own: Decision | "missing";
      if (r.owned.kind === "volume") {
        const v = await inspect(`/volumes/${encodeURIComponent(r.owned.id)}`);
        own = v.status === 404 ? "missing" : v.status === 200 && managed(labelsOf("volume", v.body)) ? { ok: true } : { ok: false, why: `volume ${r.owned.id} is not a launcher workspace volume.` };
      } else own = await ownedBy("helper", r.owned.id);
      if (own !== "missing" && !own.ok) return refuse(res, method, url, own.why);
    }
    if (!r.createsHelper) return forward(req, res, null);
    const pb = (await parseBody(req, res, method, url)) as { raw: Buffer; parsed: unknown } | undefined;
    if (!pb) return;
    const d = checkHelperCreate(pb.parsed, new URLSearchParams(url.split("?")[1] ?? ""), HELPER_IMAGE, uid);
    if (!d.ok) return refuse(res, method, url, d.why);
    // The volume the helper mounts must be one the launcher created.
    const bind = String(((pb.parsed as { HostConfig: { Binds: string[] } }).HostConfig.Binds[0] ?? "").split(":")[0]);
    const v = await inspect(`/volumes/${encodeURIComponent(bind)}`);
    if (v.status !== 200 || !managed(labelsOf("volume", v.body))) return refuse(res, method, url, `volume ${bind} is not a launcher workspace volume.`);
    forward(req, res, pb.raw);
  })().catch((e: unknown) => fail(res, e));
}

function launcherHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const r = route(method, url);
    if (!r.decision.ok) return refuse(res, method, url, r.decision.why);
    const q = new URLSearchParams(url.split("?")[1] ?? "");
    if (r.image !== undefined && !images.has(decodeURIComponent(r.image))) return refuse(res, method, url, "Only the allowed runner images may be inspected.");
    if (r.list === "containers" || r.list === "volumes") {
      const ld = checkList(r.list, q, EDGE_SERVICE);
      if (!ld.ok) return refuse(res, method, url, ld.why);
    }
    if (r.owned) {
      const own = await ownedBy(r.owned.kind, r.owned.id, r.owned.edgeOk === true);
      if (own !== "missing" && !own.ok) return refuse(res, method, url, own.why);
    }
    if (!r.body) return forward(req, res, null, r.list === "networks" ? slimNetworks : undefined);
    const pb = (await parseBody(req, res, method, url)) as { raw: Buffer; parsed: unknown } | undefined;
    if (!pb) return;
    const d =
      r.body === "container" ? checkContainer(pb.parsed, q, images, limits)
      : r.body === "network" ? checkNetwork(pb.parsed)
      : r.body === "volume" ? checkVolume(pb.parsed)
      : checkConnect(pb.parsed);
    if (!d.ok) return refuse(res, method, url, d.why);
    if (r.body === "connect" && !(await isEdge(String((pb.parsed as { Container: string }).Container)))) return refuse(res, method, url, "Only the edge may be connected to a run network.");
    forward(req, res, pb.raw);
  })().catch((e: unknown) => fail(res, e));
}

export function createProxy(profile: "launcher" | "workspace" = PROFILE): http.Server {
  return http.createServer(profile === "workspace" ? workspaceHandler : launcherHandler);
}

if (process.argv[1]?.endsWith("sockproxy.js")) {
  const server = createProxy();
  server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "sockproxy listening", profile: PROFILE, port: PORT, images: [...images] })));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
