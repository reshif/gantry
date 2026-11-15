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
  const path = decodeURIComponent((rawPath.split("?")[0] ?? "").replace(VERSION, ""));
  const no = (why: string): Route => ({ decision: deny(why), owned: null, body: null });
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

/**
 * A container create must be the runner template: an allow-listed image, owned labels, its own run network and workspace
 * volume, read-only root, all capabilities dropped, no-new-privileges, not root, and none of the escape hatches.
 */
export function checkContainer(body: unknown, query: URLSearchParams, images: ReadonlySet<string>): Decision {
  if (!isObj(body)) return deny("The body is not a JSON object.");
  const name = query.get("name") ?? "";
  if (!/^gantry-runner-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) return deny("Only runner containers (gantry-runner-<run>) may be created.");
  if (typeof body.Image !== "string" || !images.has(body.Image)) return deny("The image is not one of the allowed runner variants.");
  if (!managed(body.Labels as Record<string, string>)) return deny("A runner must carry the launcher's managed-by label.");
  const user = String(body.User ?? "");
  if (!user || /^(0|root)(:|$)/.test(user)) return deny("A runner must not run as root.");
  if (!empty(body.Entrypoint) || !empty(body.Cmd)) return deny("A runner uses its image's own command.");
  if (body.Volumes !== undefined && !empty(body.Volumes)) return deny("Anonymous volumes are not part of the runner template.");
  const h = body.HostConfig;
  if (!isObj(h)) return deny("HostConfig is missing.");
  if (h.Privileged === true) return deny("Privileged containers are refused.");
  if (h.ReadonlyRootfs !== true) return deny("A runner's root filesystem must be read-only.");
  if (!Array.isArray(h.CapDrop) || !h.CapDrop.includes("ALL")) return deny("A runner must drop all capabilities.");
  if (!empty(h.CapAdd)) return deny("Adding capabilities is refused.");
  const sec = Array.isArray(h.SecurityOpt) ? h.SecurityOpt.map(String) : [];
  if (!sec.some((s) => /^no-new-privileges(:true)?$/.test(s))) return deny("A runner must set no-new-privileges.");
  if (sec.some((s) => /unconfined|label[:=]disable/i.test(s))) return deny("Disabling seccomp, AppArmor or SELinux is refused.");
  for (const k of ["Binds", "Devices", "DeviceCgroupRules", "DeviceRequests", "VolumesFrom", "PortBindings", "Links", "Sysctls"] as const) {
    if (!empty(h[k])) return deny(`${k} is not part of the runner template.`);
  }
  if (h.PublishAllPorts === true) return deny("Publishing ports is refused.");
  for (const k of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode", "Cgroup"] as const) {
    const v = String(h[k] ?? "");
    if (HOSTISH.has(v) || v.startsWith("container:")) return deny(`${k}=${v} shares a namespace with the host or another container.`);
  }
  if (h.Runtime !== undefined && h.Runtime !== "" && h.Runtime !== "runc") return deny("Only the default runtime is allowed.");
  if (typeof h.NetworkMode !== "string" || !/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(h.NetworkMode)) return deny("A runner joins only its own run network.");
  const mounts = Array.isArray(h.Mounts) ? h.Mounts : [];
  for (const mt of mounts) {
    if (!isObj(mt) || mt.Type !== "volume" || typeof mt.Source !== "string" || !/^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(mt.Source)) return deny("A runner mounts only its workspace volume.");
    if (isObj(mt.VolumeOptions) && isObj(mt.VolumeOptions.DriverConfig)) return deny("Volume driver options are refused.");
  }
  const nets = isObj(body.NetworkingConfig) && isObj(body.NetworkingConfig.EndpointsConfig) ? Object.keys(body.NetworkingConfig.EndpointsConfig) : [];
  if (nets.some((n) => !/^run-/.test(n))) return deny("A runner joins only run networks.");
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
