/**
 * What the Docker socket proxy lets through (Wave 1, item 8). The launcher used to hold the raw socket, which is root on the host:
 * whoever controlled it could create a privileged container with the host's filesystem mounted. The proxy holds the socket
 * instead and allows only the calls the launcher makes, on the resources it owns, and a container create only when it
 * matches the fixed runner template (template.ts). Pure functions here; sockproxy.ts does the HTTP.
 */
import { LABEL_MANAGED, MANAGED_BY, TOKEN_FILE_NAME, WORKSPACE_PATH } from "./template.js";

export type Decision = { ok: true } | { ok: false; why: string };
const allow: Decision = { ok: true };
const deny = (why: string): Decision => ({ ok: false, why });

/** The kind of resource a path acts on, when the proxy must check that the launcher owns it before passing the call. */
export type Owned = { kind: "container" | "network" | "volume"; id: string; /** A read of the edge container (found by its compose labels) is allowed though the launcher does not own it. */ edgeOk?: true } | null;

export interface Route {
  decision: Decision;
  /** Resource to look up and require the managed-by label on, before forwarding. */
  owned: Owned;
  /** The request body must be checked by checkBody before forwarding. */
  body: "container" | "network" | "volume" | "connect" | "archive" | null;
  /** A list call: the proxy requires a label filter (containers, volumes) or strips detail from the answer (networks). */
  list?: "containers" | "networks" | "volumes";
  /** An image inspect: only the allow-listed runner images. */
  image?: string;
}

const VERSION = /^\/v\d+\.\d+(?=\/)/;
const SEG = "([^/?#]+)";

/** Routes the launcher uses, by method. Anything else is refused. */
export function route(method: string, rawPath: string): Route {
  const no = (why: string): Route => ({ decision: deny(why), owned: null, body: null });
  const rawNoQuery = (rawPath.split("?")[0] ?? "").replace(VERSION, "");
  let path: string;
  try {
    path = decodeURIComponent(rawNoQuery);
  } catch {
    return no("The path has an invalid percent-escape.");
  }
  // The raw URL is what gets forwarded to Docker, so refuse any form Docker might resolve differently from the match below.
  for (const p of [rawNoQuery, path]) {
    const segs = p.split("/").slice(1);
    if (!p.startsWith("/") || segs.some((sg, i) => sg === "." || sg === ".." || (sg === "" && !(i === 0 && segs.length === 1)))) {
      return no("The path has a dot or empty segment.");
    }
  }
  const ok = (owned: Owned = null, body: Route["body"] = null): Route => ({ decision: allow, owned, body });
  const m = (re: string) => new RegExp(`^${re}$`).exec(path);
  let x: RegExpExecArray | null;
  switch (method) {
    case "HEAD":
    case "GET":
      if (path === "/_ping" || path === "/version") return ok();
      if (path === "/containers/json") return { ...ok(), list: "containers" };
      if (path === "/networks") return { ...ok(), list: "networks" };
      if (path === "/volumes") return { ...ok(), list: "volumes" };
      // Reads are owned-only too: an inspect carries env (a runner's run token), binds, mounts and addresses.
      if ((x = m(`/containers/${SEG}/json`))) return ok({ kind: "container", id: x[1]!, edgeOk: true });
      if ((x = m(`/networks/${SEG}`))) return ok({ kind: "network", id: x[1]! });
      if ((x = m(`/volumes/${SEG}`))) return ok({ kind: "volume", id: x[1]! });
      if ((x = m(`/images/(.+)/json`))) return { ...ok(), image: x[1]! };
      return no(`GET ${path} is not a call the launcher makes.`);
    case "POST":
      if (path === "/containers/create") return ok(null, "container");
      if ((x = m(`/containers/${SEG}/(start|stop|kill|wait)`))) return ok({ kind: "container", id: x[1]! });
      if (path === "/networks/create") return ok(null, "network");
      if ((x = m(`/networks/${SEG}/(connect|disconnect)`))) return ok({ kind: "network", id: x[1]! }, x[2] === "connect" ? "connect" : null);
      if (path === "/volumes/create") return ok(null, "volume");
      return no(`POST ${path} is not a call the launcher makes.`);
    case "PUT":
      // The run token file, copied into the workspace volume of a created container (checkTokenArchive).
      if ((x = m(`/containers/${SEG}/archive`))) return ok({ kind: "container", id: x[1]! }, "archive");
      return no(`PUT ${path} is not a call the launcher makes.`);
    case "DELETE":
      if ((x = m(`/containers/${SEG}`))) return ok({ kind: "container", id: x[1]! });
      if ((x = m(`/networks/${SEG}`))) return ok({ kind: "network", id: x[1]! });
      if ((x = m(`/volumes/${SEG}`))) return ok({ kind: "volume", id: x[1]! });
      return no(`DELETE ${path} is not a call the launcher makes.`);
    default:
      return no(`${method} is not allowed.`);
  }
}

/** True when a resource's labels say the launcher owns it. */
export const managed = (labels: Record<string, string> | null | undefined): boolean => !!labels && labels[LABEL_MANAGED] === MANAGED_BY;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);
const HOSTISH = new Set(["host"]);
const NAME = "[A-Za-z0-9][A-Za-z0-9_-]{0,62}";

/**
 * Default-deny shape of a runner create: exactly the keys template.ts (runnerContainerOptions) emits, at the top level and
 * in HostConfig. A key outside these lists (MaskedPaths, ReadonlyPaths, CgroupParent, Isolation, StorageOpt, GroupAdd,
 * Annotations, Healthcheck, Domainname, ExposedPorts, Volumes...) is refused whatever its value. Keep in step with template.ts.
 */
const TOP_KEYS = new Set(["name", "Image", "User", "WorkingDir", "Env", "Labels", "StopSignal", "StopTimeout", "AttachStdin", "Tty", "OpenStdin", "NetworkDisabled", "HostConfig", "NetworkingConfig"]);
const HOST_KEYS = new Set([
  "NetworkMode", "Privileged", "ReadonlyRootfs", "CapDrop", "SecurityOpt", "Tmpfs", "Mounts", "Memory", "MemorySwap", "NanoCpus", "PidsLimit",
  "RestartPolicy", "AutoRemove", "PublishAllPorts", "IpcMode", "PidMode", "UsernsMode", "Binds", "Devices", "DeviceCgroupRules", "ExtraHosts",
  "Dns", "Links", "VolumesFrom", "Ulimits", "LogConfig",
]);
const RUN_ENV = /^(?:(?:EDGE_URL|HTTPS_PROXY|GANTRY_RUN_ID)=|GANTRY_WORKSPACE_MAX_MB=\d{1,9}$)/;
const TMP_OPTS = /^rw,noexec,nosuid,nodev,size=\d+$/;

/**
 * A container create must be the runner template: an allow-listed image, owned labels, its own run network and workspace
 * volume, read-only root, all capabilities dropped, no-new-privileges, not root, and none of the escape hatches. Anything
 * the template does not emit is refused.
 */
export interface RunnerLimits {
  uid: number;
  gid: number;
  /** Ceilings: the launcher's RUNNER_MEMORY_MB, RUNNER_PIDS and RUNNER_CPUS. A create must state its limits and stay at or under these. */
  memoryBytes: number;
  pids: number;
  nanoCpus: number;
}
/** The launcher's own defaults (config.ts). The proxy builds its own from the same environment variables. */
export const DEFAULT_LIMITS: RunnerLimits = { uid: 10001, gid: 10001, memoryBytes: 4096 * 1024 * 1024, pids: 512, nanoCpus: 2e9 };
/** The workspace volume ceiling the proxy enforces (WORKSPACE_MAX_MB). */
export interface VolumeLimits { maxMb: number; uid: number; gid: number }
export const DEFAULT_VOLUME_LIMITS: VolumeLimits = { maxMb: 10240, uid: 10001, gid: 10001 };

const posInt = (v: unknown, max: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
const LABEL_KEYS = new Set(["gantry.run", "gantry.managed-by", "gantry.variant", "gantry.workspace-ref"]);

export function checkContainer(body: unknown, query: URLSearchParams, images: ReadonlySet<string>, limits: RunnerLimits = DEFAULT_LIMITS): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  const name = query.get("name") ?? "";
  if (!/^gantry-runner-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) return deny("Only runner containers (gantry-runner-<run>) may be created.");
  const extraTop = Object.keys(body).find((k) => !TOP_KEYS.has(k));
  if (extraTop) return deny(`${extraTop} is not part of the runner template.`);
  if (typeof body.Image !== "string" || !images.has(body.Image)) return deny("The image is not one of the allowed runner variants.");
  if (!managed(body.Labels as Record<string, string>)) return deny("A runner must carry the launcher's managed-by label.");
  // Exactly the four gantry.* labels the template sets: a spoofed com.docker.compose.* label could pass the edge check on network connect.
  const labels = body.Labels as Record<string, unknown>;
  if (Object.keys(labels).some((k) => !LABEL_KEYS.has(k)) || Object.values(labels).some((v) => typeof v !== "string")) return deny("A runner carries only the template's four gantry.* labels.");
  const runName = name.slice("gantry-runner-".length);
  if (labels["gantry.run"] !== runName) return deny("The run label must match the container name.");
  // Exactly uid:gid from the launcher's configuration. "00", "+0:0", "10001:0" and names all fail this string comparison.
  if (body.User !== `${limits.uid}:${limits.gid}` || limits.uid === 0 || limits.gid === 0) return deny("A runner must run as the configured non-root uid:gid, exactly.");
  if (body.WorkingDir !== undefined && body.WorkingDir !== "/workspace") return deny("A runner's working directory is /workspace.");
  if (body.Env !== undefined) {
    // The run token is never in the environment (it would be readable from /proc/1/environ): not as GANTRY_RUN_TOKEN, and not as proxy credentials.
    if (!Array.isArray(body.Env) || body.Env.some((e) => typeof e !== "string" || /GANTRY_RUN_TOKEN/i.test(e))) return deny("A runner's environment must not carry the run token; it is delivered in a file.");
    if (body.Env.some((e) => !RUN_ENV.test(e as string))) return deny("A runner's environment is only the four variables the template sets.");
    for (const e of body.Env as string[]) {
      if (!e.startsWith("HTTPS_PROXY=")) continue;
      let u: URL;
      try {
        u = new URL(e.slice("HTTPS_PROXY=".length));
      } catch {
        return deny("HTTPS_PROXY is not a URL.");
      }
      if (u.username || u.password || u.search || u.hash) return deny("A runner's HTTPS_PROXY must carry no credentials; the run token is delivered in a file.");
    }
  }
  if (body.AttachStdin === true || body.OpenStdin === true || body.Tty === true) return deny("A runner takes no stdin and no tty.");
  const h = body.HostConfig;
  if (!isObj(h)) return deny("HostConfig is missing.");
  const extraHost = Object.keys(h).find((k) => !HOST_KEYS.has(k));
  if (extraHost) return deny(`HostConfig.${extraHost} is not part of the runner template.`);
  if (h.Privileged === true) return deny("Privileged containers are refused.");
  if (h.ReadonlyRootfs !== true) return deny("A runner's root filesystem must be read-only.");
  if (!Array.isArray(h.CapDrop) || !h.CapDrop.includes("ALL")) return deny("A runner must drop all capabilities.");
  // Exactly the template's one option: no inline seccomp profile, no SELinux or AppArmor type, nothing else.
  if (!Array.isArray(h.SecurityOpt) || h.SecurityOpt.length !== 1 || h.SecurityOpt[0] !== "no-new-privileges:true") return deny("SecurityOpt must be exactly no-new-privileges:true.");
  if (!Array.isArray(h.CapDrop) || h.CapDrop.length !== 1 || h.CapDrop[0] !== "ALL") return deny("A runner must drop all capabilities (CapDrop is exactly ALL).");
  if (!posInt(h.Memory, limits.memoryBytes) || !posInt(h.MemorySwap, limits.memoryBytes)) return deny("A runner must state a memory limit (and equal swap) at or under the ceiling.");
  if (!posInt(h.PidsLimit, limits.pids)) return deny("A runner must state a pids limit at or under the ceiling.");
  if (!posInt(h.NanoCpus, limits.nanoCpus)) return deny("A runner must state a CPU limit at or under the ceiling.");
  for (const k of ["Binds", "Devices", "DeviceCgroupRules", "VolumesFrom", "Links", "Dns", "ExtraHosts"] as const) {
    if (!empty(h[k])) return deny(`${k} is not part of the runner template.`);
  }
  if (h.PublishAllPorts === true) return deny("Publishing ports is refused.");
  if (h.IpcMode !== "private") return deny("IpcMode must be private.");
  for (const k of ["PidMode", "UsernsMode"] as const) {
    const v = String(h[k] ?? "");
    if (v !== "" || HOSTISH.has(v)) return deny(`${k} must be left at the default.`);
  }
  if (h.Tmpfs !== undefined) {
    if (!isObj(h.Tmpfs) || Object.keys(h.Tmpfs).some((k) => k !== "/tmp") || (h.Tmpfs["/tmp"] !== undefined && (typeof h.Tmpfs["/tmp"] !== "string" || !TMP_OPTS.test(h.Tmpfs["/tmp"])))) {
      return deny("Only /tmp may be a tmpfs, with the template's options (rw,noexec,nosuid,nodev,size).");
    }
  }
  if (h.Ulimits !== undefined) {
    const u = h.Ulimits;
    if (!Array.isArray(u) || u.length !== 1 || !isObj(u[0]) || u[0].Name !== "nofile" || u[0].Soft !== 4096 || u[0].Hard !== 4096 || Object.keys(u[0]).length !== 3) return deny("Ulimits are fixed to the template's nofile limit.");
  }
  if (h.LogConfig !== undefined) {
    const lc = h.LogConfig;
    if (!isObj(lc) || lc.Type !== "json-file" || Object.keys(lc).some((k) => k !== "Type" && k !== "Config") || (lc.Config !== undefined && (!isObj(lc.Config) || Object.keys(lc.Config).some((k) => k !== "max-size" && k !== "max-file")))) return deny("Log configuration is fixed to the template's json-file rotation.");
  }
  if (h.RestartPolicy !== undefined && (!isObj(h.RestartPolicy) || (h.RestartPolicy.Name !== "no" && h.RestartPolicy.Name !== ""))) return deny("A runner is never restarted by Docker.");
  if (h.NetworkMode !== `run-${runName}`) return deny("A runner joins only the run network of its own run id.");
  const mounts = Array.isArray(h.Mounts) ? h.Mounts : [];
  for (const mt of mounts) {
    if (!isObj(mt) || mt.Type !== "volume" || mt.Source !== `ws-${runName}` || mt.Target !== "/workspace") return deny("A runner mounts only the workspace volume of its own run id at /workspace.");
    if (Object.keys(mt).some((k) => !["Type", "Source", "Target", "ReadOnly"].includes(k))) return deny("Volume mount options are refused.");
  }
  const nets = isObj(body.NetworkingConfig) && isObj(body.NetworkingConfig.EndpointsConfig) ? Object.keys(body.NetworkingConfig.EndpointsConfig) : [];
  if (nets.some((n) => n !== h.NetworkMode)) return deny("A runner joins only its own run network.");
  return allow;
}

const ARCHIVE_PATH = WORKSPACE_PATH;
/**
 * The only archive the launcher copies into a runner: its token file, as a one-entry tar (see tokenArchive), into /workspace. One regular file
 * with the template's name, at most 1 kB, mode no wider than 0600, and nothing after it but the end-of-archive padding.
 */
export function checkTokenArchive(query: URLSearchParams, raw: Buffer): Decision {
  if (query.get("path") !== ARCHIVE_PATH) return deny(`An archive may only be copied to ${ARCHIVE_PATH}.`);
  for (const k of query.keys()) if (k !== "path") return deny("An archive copy takes only the path parameter.");
  if (raw.length < 1536 || raw.length % 512 !== 0 || raw.length > 4096) return deny("The archive is not the one-file token archive.");
  const h = raw.subarray(0, 512);
  const field = (o: number, n: number) => h.subarray(o, o + n).toString("latin1").replace(/\0.*$/s, "");
  if (field(0, 100) !== TOKEN_FILE_NAME || field(345, 155) !== "") return deny("The archive must hold only the token file.");
  if (h[156] !== 0x30 && h[156] !== 0) return deny("The archive entry must be a regular file.");
  if (h.subarray(157, 257).some((b) => b !== 0)) return deny("The archive entry must not link anywhere.");
  const size = parseInt(field(124, 12).trim() || "x", 8);
  const mode = parseInt(field(100, 8).trim() || "x", 8);
  if (!Number.isInteger(size) || size < 1 || size > 1024) return deny("The token file is empty or too large.");
  if (!Number.isInteger(mode) || (mode & 0o177) !== 0) return deny("The token file must be readable by its owner only.");
  const end = 512 + Math.ceil(size / 512) * 512;
  if (raw.length < end + 1024 || raw.subarray(end).some((b) => b !== 0)) return deny("The archive holds more than the token file.");
  return allow;
}

/** A run network: internal, bridge, named run-<id>, owned. */
export function checkNetwork(body: unknown): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  if (typeof body.Name !== "string" || !/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(body.Name)) return deny("Only run networks (run-<run>) may be created.");
  if (body.Internal !== true) return deny("A run network must be internal (no route out except through the edge).");
  if (body.Driver !== undefined && body.Driver !== "bridge") return deny("A run network uses the bridge driver.");
  if (!managed(body.Labels as Record<string, string>)) return deny("A run network must carry the launcher's managed-by label.");
  if (isObj(body.Options) && Object.keys(body.Options).length) return deny("Driver options are refused.");
  return allow;
}

/**
 * A workspace volume: local, named ws-<id>, owned. Driver options are refused (they can bind a host path), with one exception (S-90): exactly the
 * size-limited tmpfs the launcher sets, `type=tmpfs device=tmpfs o=size=<n>m,uid=<runner>,gid=<runner>,mode=0755`, n at or under the ceiling. No other key,
 * no other option, nothing that names a host path.
 */
export function checkVolume(body: unknown, limits: VolumeLimits = DEFAULT_VOLUME_LIMITS): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  if (typeof body.Name !== "string" || !/^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(body.Name)) return deny("Only workspace volumes (ws-<run>) may be created.");
  if (body.Driver !== undefined && body.Driver !== "local") return deny("A workspace volume uses the local driver.");
  if (!empty(body.DriverOpts)) {
    const o = body.DriverOpts;
    const keys = isObj(o) ? Object.keys(o).sort().join(",") : "";
    const m = isObj(o) && typeof o.o === "string" ? /^size=([1-9]\d{0,8})m,uid=(\d+),gid=(\d+),mode=0755$/.exec(o.o) : null;
    const ok = isObj(o) && keys === "device,o,type" && o.type === "tmpfs" && o.device === "tmpfs" && m !== null && Number(m[1]) <= limits.maxMb && Number(m[2]) === limits.uid && Number(m[3]) === limits.gid;
    if (!ok) return deny("Volume driver options are refused (they can bind a host path); only the size-limited tmpfs workspace is allowed.");
  }
  if (!managed(body.Labels as Record<string, string>)) return deny("A workspace volume must carry the launcher's managed-by label.");
  return allow;
}

/** Connecting to a run network: only the edge (by its configured name or compose labels, resolved by the proxy). */
export function checkConnect(body: unknown): Decision {
  if (!isObj(body) || typeof body.Container !== "string" || !body.Container) return deny("Say which container to connect.");
  return allow;
}

/** The filter list a Docker list call carries (`filters` is JSON: {"label":["k=v"]} or {"label":{"k=v":true}}). */
export function labelFilters(query: URLSearchParams): string[] {
  try {
    const f = JSON.parse(query.get("filters") || "{}") as { label?: unknown };
    if (Array.isArray(f.label)) return f.label.map(String);
    if (isObj(f.label)) return Object.keys(f.label);
  } catch {
    /* no usable filters */
  }
  return [];
}

/** A container or volume list is allowed only when it is filtered to the launcher's own resources, or (containers) to the edge by compose service. */
export function checkList(kind: "containers" | "volumes", query: URLSearchParams, edgeService: string): Decision {
  const l = labelFilters(query);
  if (l.includes(`${LABEL_MANAGED}=${MANAGED_BY}`)) return allow;
  if (kind === "containers" && l.includes(`com.docker.compose.service=${edgeService}`)) return allow;
  return deny(`A ${kind} list must filter on label ${LABEL_MANAGED}=${MANAGED_BY}.`);
}

/** Network list entries reduced to what subnet allocation and the concurrency count need (names, labels, subnets); endpoints, options and addresses of other containers are dropped. */
export function slimNetworks(list: unknown): unknown {
  if (!Array.isArray(list)) return [];
  return list.map((n) => {
    const o = isObj(n) ? n : {};
    const ipam = isObj(o.IPAM) ? o.IPAM : {};
    const cfg = Array.isArray(ipam.Config) ? ipam.Config.map((c) => (isObj(c) ? { Subnet: c.Subnet } : {})) : [];
    return { Id: o.Id, Name: o.Name, Driver: o.Driver, Internal: o.Internal, Labels: o.Labels ?? null, IPAM: { Config: cfg } };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Workspace profile (finding: gantry-github held the raw socket). The broker seeds and reads ws-<id> volumes through a short-lived,
// never-started helper container (services/github/src/workspace.ts). This profile lets through exactly those calls, and nothing else.
// ---------------------------------------------------------------------------------------------------------------------
export const HELPER_MANAGED_BY = "gantry-github";
export const HELPER_PURPOSE = "workspace-helper";

export interface WsRoute {
  decision: Decision;
  /** Look the resource up and require its labels: a helper container (labelled by the broker) or a launcher workspace volume. */
  owned: { kind: "helper" | "volume"; id: string } | null;
  createsHelper: boolean;
}

export function routeWorkspace(method: string, rawPath: string): WsRoute {
  const no = (why: string): WsRoute => ({ decision: deny(why), owned: null, createsHelper: false });
  const base = route("GET", rawPath); // reuse the path hygiene (dot segments, bad escapes, version prefix)
  if (!base.decision.ok && /dot or empty segment|percent-escape/.test(base.decision.why)) return no(base.decision.why);
  const [rawNoQuery = "", queryStr = ""] = rawPath.split("?");
  const path = decodeURIComponent(rawNoQuery.replace(VERSION, ""));
  const m = (re: string) => new RegExp(`^${re}$`).exec(path);
  let x: RegExpExecArray | null;
  if (method === "GET" || method === "HEAD") {
    if (path === "/_ping") return { decision: allow, owned: null, createsHelper: false };
    if ((x = m(`/volumes/(ws-${NAME})`))) return { decision: allow, owned: { kind: "volume", id: x[1]! }, createsHelper: false };
    if ((x = m(`/containers/${SEG}/archive`))) return archivePath(x[1]!, queryStr, no);
  }
  if (method === "PUT" && (x = m(`/containers/${SEG}/archive`))) return archivePath(x[1]!, queryStr, no);
  if (method === "POST" && path === "/containers/create") return { decision: allow, owned: null, createsHelper: true };
  if (method === "DELETE" && (x = m(`/containers/${SEG}`))) return { decision: allow, owned: { kind: "helper", id: x[1]! }, createsHelper: false };
  return no(`${method} ${path} is not a call the workspace broker makes.`);
}

function archivePath(id: string, queryStr: string, no: (why: string) => WsRoute): WsRoute {
  const p = new URLSearchParams(queryStr).get("path") ?? "";
  if (p !== "/workspace" && !/^\/workspace\/[A-Za-z0-9._/-]*$/.test(p)) return no("An archive path must be inside /workspace.");
  if (p.split("/").some((sg) => sg === "..")) return no("An archive path must not contain '..'.");
  return { decision: allow, owned: { kind: "helper", id }, createsHelper: false };
}

/** True when a container's labels say it is a workspace helper the broker created. */
export const isHelper = (labels: Record<string, string> | null | undefined): boolean => !!labels && labels["gantry.managed-by"] === HELPER_MANAGED_BY && labels["gantry.purpose"] === HELPER_PURPOSE;

/** The broker's helper: the exact body workspace.ts sends. Nothing else is created through this profile. */
export function checkHelperCreate(body: unknown, query: URLSearchParams, helperImage: string, uid = 10001): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  if ([...query.keys()].some((k) => k !== "name")) return deny("Unexpected create parameters.");
  // The broker names nothing today; if it ever does, the name stays inside the helper namespace so it can never squat a runner's container name.
  const names = query.getAll("name");
  if (names.length > 1 || (names.length === 1 && !/^gantry-ws-helper-[A-Za-z0-9_-]{1,40}$/.test(names[0]!))) return deny("A helper's name, when given, is gantry-ws-helper-<id>.");
  if (body.Image !== helperImage) return deny("The helper image is fixed.");
  const keys = new Set(["Image", "Entrypoint", "Cmd", "User", "NetworkDisabled", "Labels", "HostConfig"]);
  const extra = Object.keys(body).find((k) => !keys.has(k));
  if (extra) return deny(`${extra} is not part of the helper template.`);
  if (!Array.isArray(body.Entrypoint) || body.Entrypoint.length !== 1 || body.Entrypoint[0] !== "/bin/true") return deny("The helper's entrypoint is /bin/true.");
  if (!empty(body.Cmd)) return deny("The helper has no command.");
  if (body.User !== `${uid}:${uid}`) return deny("The helper runs as the runner uid:gid.");
  if (body.NetworkDisabled !== true) return deny("The helper has no network.");
  const l = body.Labels;
  if (!isObj(l) || Object.keys(l).length !== 2 || !isHelper(l as Record<string, string>)) return deny("The helper carries exactly the broker's two labels.");
  const h = body.HostConfig;
  if (!isObj(h)) return deny("HostConfig is missing.");
  const hk = new Set(["Binds", "NetworkMode", "ReadonlyRootfs", "CapDrop", "SecurityOpt", "Memory", "PidsLimit", "AutoRemove"]);
  const hx = Object.keys(h).find((k) => !hk.has(k));
  if (hx) return deny(`HostConfig.${hx} is not part of the helper template.`);
  if (!Array.isArray(h.Binds) || h.Binds.length !== 1 || typeof h.Binds[0] !== "string" || !new RegExp(`^ws-${NAME}:/workspace(:ro)?$`).test(h.Binds[0])) return deny("The helper mounts exactly one ws-<id> volume at /workspace.");
  if (h.NetworkMode !== "none") return deny("The helper's network mode is none.");
  if (h.ReadonlyRootfs !== true) return deny("The helper's root is read-only.");
  if (!Array.isArray(h.CapDrop) || h.CapDrop.length !== 1 || h.CapDrop[0] !== "ALL") return deny("The helper drops all capabilities.");
  if (!Array.isArray(h.SecurityOpt) || h.SecurityOpt.length !== 1 || !/^no-new-privileges(:true)?$/.test(String(h.SecurityOpt[0]))) return deny("The helper's SecurityOpt is no-new-privileges only.");
  if (!posInt(h.Memory, 256 * 1024 * 1024) || !posInt(h.PidsLimit, 64)) return deny("The helper states small memory and pids limits.");
  if (h.AutoRemove !== false && h.AutoRemove !== undefined) return deny("AutoRemove is not part of the helper template.");
  return allow;
}
