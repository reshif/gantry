/**
 * What the Docker socket proxy lets through (Wave 1, item 8). The launcher used to hold the raw socket, which is root on the host:
 * whoever controlled it could create a privileged container with the host's filesystem mounted. The proxy holds the socket
 * instead and allows only the calls the launcher makes, on the resources it owns, and a container create only when it
 * matches the fixed runner template (template.ts). Pure functions here; sockproxy.ts does the HTTP.
 */
import { LABEL_MANAGED, MANAGED_BY } from "./template.js";

export type Decision = { ok: true } | { ok: false; why: string };
const allow: Decision = { ok: true };
const deny = (why: string): Decision => ({ ok: false, why });

/** The kind of resource a path acts on, when the proxy must check that the launcher owns it before passing the call. */
export type Owned = { kind: "container" | "network" | "volume"; id: string } | null;

export interface Route {
  decision: Decision;
  /** Resource to look up and require the managed-by label on, before forwarding. */
  owned: Owned;
  /** The request body must be checked by checkBody before forwarding. */
  body: "container" | "network" | "volume" | "connect" | null;
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
      if (path === "/containers/json" || path === "/networks" || path === "/volumes") return ok();
      if ((x = m(`/containers/${SEG}/json`))) return ok();
      if ((x = m(`/networks/${SEG}`))) return ok();
      if ((x = m(`/volumes/${SEG}`))) return ok();
      if ((x = m(`/images/(.+)/json`))) return ok();
      return no(`GET ${path} is not a call the launcher makes.`);
    case "POST":
      if (path === "/containers/create") return ok(null, "container");
      if ((x = m(`/containers/${SEG}/(start|stop|kill|wait)`))) return ok({ kind: "container", id: x[1]! });
      if (path === "/networks/create") return ok(null, "network");
      if ((x = m(`/networks/${SEG}/(connect|disconnect)`))) return ok({ kind: "network", id: x[1]! }, x[2] === "connect" ? "connect" : null);
      if (path === "/volumes/create") return ok(null, "volume");
      return no(`POST ${path} is not a call the launcher makes.`);
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
const RUN_ENV = /^(EDGE_URL|HTTPS_PROXY|GANTRY_RUN_TOKEN|GANTRY_RUN_ID)=/;
const TMP_OPTS = /^rw,noexec,nosuid,nodev,size=\d+$/;

/**
 * A container create must be the runner template: an allow-listed image, owned labels, its own run network and workspace
 * volume, read-only root, all capabilities dropped, no-new-privileges, not root, and none of the escape hatches. Anything
 * the template does not emit is refused.
 */
export function checkContainer(body: unknown, query: URLSearchParams, images: ReadonlySet<string>): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  const name = query.get("name") ?? "";
  if (!/^gantry-runner-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) return deny("Only runner containers (gantry-runner-<run>) may be created.");
  const extraTop = Object.keys(body).find((k) => !TOP_KEYS.has(k));
  if (extraTop) return deny(`${extraTop} is not part of the runner template.`);
  if (typeof body.Image !== "string" || !images.has(body.Image)) return deny("The image is not one of the allowed runner variants.");
  if (!managed(body.Labels as Record<string, string>)) return deny("A runner must carry the launcher's managed-by label.");
  const user = String(body.User ?? "");
  if (!user || /^(0|root)(:|$)/.test(user)) return deny("A runner must not run as root.");
  if (body.WorkingDir !== undefined && body.WorkingDir !== "/workspace") return deny("A runner's working directory is /workspace.");
  if (body.Env !== undefined && (!Array.isArray(body.Env) || body.Env.some((e) => typeof e !== "string" || !RUN_ENV.test(e)))) return deny("A runner's environment is only the four variables the template sets.");
  const h = body.HostConfig;
  if (!isObj(h)) return deny("HostConfig is missing.");
  const extraHost = Object.keys(h).find((k) => !HOST_KEYS.has(k));
  if (extraHost) return deny(`HostConfig.${extraHost} is not part of the runner template.`);
  if (h.Privileged === true) return deny("Privileged containers are refused.");
  if (h.ReadonlyRootfs !== true) return deny("A runner's root filesystem must be read-only.");
  if (!Array.isArray(h.CapDrop) || !h.CapDrop.includes("ALL")) return deny("A runner must drop all capabilities.");
  const sec = Array.isArray(h.SecurityOpt) ? h.SecurityOpt.map(String) : [];
  if (!sec.some((s) => /^no-new-privileges(:true)?$/.test(s))) return deny("A runner must set no-new-privileges.");
  if (sec.some((s) => /unconfined|label[:=]disable/i.test(s))) return deny("Disabling seccomp, AppArmor or SELinux is refused.");
  for (const k of ["Binds", "Devices", "DeviceCgroupRules", "VolumesFrom", "Links", "Dns", "ExtraHosts"] as const) {
    if (!empty(h[k])) return deny(`${k} is not part of the runner template.`);
  }
  if (h.PublishAllPorts === true) return deny("Publishing ports is refused.");
  for (const k of ["PidMode", "IpcMode", "UsernsMode"] as const) {
    const v = String(h[k] ?? "");
    if (HOSTISH.has(v) || v.startsWith("container:")) return deny(`${k}=${v} shares a namespace with the host or another container.`);
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
  if (typeof h.NetworkMode !== "string" || !new RegExp(`^run-${NAME}$`).test(h.NetworkMode)) return deny("A runner joins only its own run network.");
  const mounts = Array.isArray(h.Mounts) ? h.Mounts : [];
  for (const mt of mounts) {
    if (!isObj(mt) || mt.Type !== "volume" || typeof mt.Source !== "string" || !new RegExp(`^ws-${NAME}$`).test(mt.Source) || mt.Target !== "/workspace") return deny("A runner mounts only its workspace volume at /workspace.");
    if (Object.keys(mt).some((k) => !["Type", "Source", "Target", "ReadOnly"].includes(k))) return deny("Volume mount options are refused.");
  }
  const nets = isObj(body.NetworkingConfig) && isObj(body.NetworkingConfig.EndpointsConfig) ? Object.keys(body.NetworkingConfig.EndpointsConfig) : [];
  if (nets.some((n) => n !== h.NetworkMode)) return deny("A runner joins only its own run network.");
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

/** A workspace volume: local, named ws-<id>, owned, no driver options (which could bind a host path). */
export function checkVolume(body: unknown): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  if (typeof body.Name !== "string" || !/^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(body.Name)) return deny("Only workspace volumes (ws-<run>) may be created.");
  if (body.Driver !== undefined && body.Driver !== "local") return deny("A workspace volume uses the local driver.");
  if (!empty(body.DriverOpts)) return deny("Volume driver options are refused (they can bind a host path).");
  if (!managed(body.Labels as Record<string, string>)) return deny("A workspace volume must carry the launcher's managed-by label.");
  return allow;
}

/** Connecting to a run network: only the edge (by its configured name or compose labels, resolved by the proxy). */
export function checkConnect(body: unknown): Decision {
  if (!isObj(body) || typeof body.Container !== "string" || !body.Container) return deny("Say which container to connect.");
  return allow;
}
