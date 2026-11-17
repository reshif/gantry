import type { ContainerCreateOptions, NetworkCreateOptions } from "dockerode";
import { z } from "zod";
import type { LauncherConfig } from "./config.js";

/** Labels that mark everything the launcher owns. The reaper and list-runs find resources by these. */
export const LABEL_RUN = "gantry.run";
export const LABEL_MANAGED = "gantry.managed-by";
export const LABEL_VARIANT = "gantry.variant";
export const LABEL_WORKSPACE = "gantry.workspace-ref";
export const MANAGED_BY = "gantry-launcher";

export const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, "run id: letters, digits, _ and -, at most 63 characters");
const workspaceRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/, "workspace reference: 1-200 safe characters");
const runToken = z.string().regex(/^[A-Za-z0-9._~+/=-]{16,512}$/, "run token: 16-512 URL-safe characters");

/**
 * The whole caller-controlled surface of start-run. Strict: any other field (image, command, binds, privileged...) is refused.
 * `runToken` is the per-run credential issued by the API (spec 4.3 step 3); the launcher only forwards it.
 * `seedComplete: false` prepares network and volume only, so gantry-github can seed the volume before the runner exists;
 * a later call with `seedComplete` true or absent starts the container.
 */
export function startRunSchema(cfg: LauncherConfig) {
  return z.strictObject({
    runId,
    workspaceRef,
    variant: z.string().refine((v) => cfg.variants.has(v), "variant is not in the allow-list"),
    runToken,
    seedComplete: z.boolean().optional(),
  });
}
export type StartRunInput = z.infer<ReturnType<typeof startRunSchema>>;

export const names = {
  network: (id: string) => `run-${id}`,
  volume: (id: string) => `ws-${id}`,
  container: (id: string) => `gantry-runner-${id}`,
};

export const WORKSPACE_PATH = "/workspace";
export const TMP_OPTIONS = (bytes: number) => `rw,noexec,nosuid,nodev,size=${bytes}`;

export function runLabels(input: Pick<StartRunInput, "runId" | "workspaceRef" | "variant">): Record<string, string> {
  return {
    [LABEL_RUN]: input.runId,
    [LABEL_MANAGED]: MANAGED_BY,
    [LABEL_VARIANT]: input.variant,
    [LABEL_WORKSPACE]: input.workspaceRef,
  };
}

export function networkOptions(cfg: LauncherConfig, input: StartRunInput, subnet: string): NetworkCreateOptions {
  void cfg;
  return {
    Name: names.network(input.runId),
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    CheckDuplicate: true,
    IPAM: { Driver: "default", Config: [{ Subnet: subnet }] },
    Labels: runLabels(input),
  };
}

/**
 * The edge's forward proxy identifies a run by Basic credentials `run:<runToken>` (services/edge/src/proxy.ts). The container is given the proxy
 * URL WITHOUT credentials: the wrapper's loopback relay adds them from the token it read from the token file.
 */
export function proxyUrlPlain(proxyUrl: string): string {
  const u = new URL(proxyUrl);
  u.username = "";
  u.password = "";
  return u.toString().replace(/\/$/, "");
}

/**
 * The run token is delivered in a file, never in the container's environment (an environment is readable from /proc/1/environ by every process of
 * the same uid, for the whole life of the container). The launcher creates the container, copies this one-file archive into the workspace volume
 * (PUT /containers/<id>/archive, allowed on a volume path even with a read-only root), then starts it. The wrapper, PID 1, reads the file first
 * thing and unlinks it before it starts anything else (runner/wrapper/src/token.ts).
 */
export const TOKEN_FILE_NAME = ".gantry-run-token";
export const TOKEN_FILE_PATH = `${WORKSPACE_PATH}/${TOKEN_FILE_NAME}`;

/** A one-entry ustar archive: TOKEN_FILE_NAME, mode 0400, owned by the runner uid:gid. */
export function tokenArchive(token: string, uid: number, gid: number): Buffer {
  const data = Buffer.from(token, "utf8");
  const h = Buffer.alloc(512);
  const put = (off: number, len: number, v: string) => void h.write(v, off, len, "ascii");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(0, 100, TOKEN_FILE_NAME);
  put(100, 8, oct(0o400, 8));
  put(108, 8, oct(uid, 8));
  put(116, 8, oct(gid, 8));
  put(124, 12, oct(data.length, 12));
  put(136, 12, oct(Math.floor(Date.now() / 1000), 12));
  put(148, 8, "        ");
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024)]);
}

/**
 * The fixed runner template (spec 4.1). Nothing here comes from the caller except the id, the image chosen from
 * the allow-list and the labels. The per-run token is NOT in the create body: see tokenArchive. There is deliberately no parameter for anything else.
 */
/**
 * dockerode's createContainer sends its whole options object as the query string AND as the body (every 4.x release does). The socket proxy
 * only allows `name` in the query, and a runner's env carries its run token, which must not sit in a URL that gets logged. `_query` and
 * `_body` are docker-modem's own split: the query is just the name, the body is the rest.
 */
export function createRequest<T extends { name?: string }>(o: T): ContainerCreateOptions & { _query: { name?: string }; _body: Omit<T, "name"> } {
  const { name, ...body } = o;
  return { _query: name === undefined ? {} : { name }, _body: body };
}

export function runnerContainerOptions(cfg: LauncherConfig, input: StartRunInput): ContainerCreateOptions {
  const image = cfg.variants.get(input.variant);
  if (image === undefined) throw new Error(`variant ${input.variant} is not allowed`); // validated upstream: a bug if reached
  const net = names.network(input.runId);
  const l = cfg.limits;
  return {
    name: names.container(input.runId),
    Image: image,
    User: `${l.uid}:${l.gid}`,
    WorkingDir: WORKSPACE_PATH,
    Env: [
      `EDGE_URL=${cfg.runnerEnv.edgeUrl}`,
      `HTTPS_PROXY=${proxyUrlPlain(cfg.runnerEnv.proxyUrl)}`,
      `GANTRY_RUN_ID=${input.runId}`,
    ],
    Labels: runLabels(input),
    StopSignal: "SIGTERM",
    StopTimeout: l.stopGraceSeconds,
    AttachStdin: false,
    Tty: false,
    OpenStdin: false,
    NetworkDisabled: false,
    HostConfig: {
      NetworkMode: net,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": TMP_OPTIONS(l.tmpBytes) },
      Mounts: [{ Type: "volume", Source: names.volume(input.runId), Target: WORKSPACE_PATH, ReadOnly: false }],
      Memory: l.memoryBytes,
      MemorySwap: l.memoryBytes,
      NanoCpus: l.nanoCpus,
      PidsLimit: l.pids,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PublishAllPorts: false,
      IpcMode: "private",
      PidMode: "",
      UsernsMode: "",
      Binds: [],
      Devices: [],
      DeviceCgroupRules: [],
      ExtraHosts: [],
      Dns: [],
      Links: [],
      VolumesFrom: [],
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    NetworkingConfig: { EndpointsConfig: { [net]: {} } },
  };
}
