import { readFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { z } from "zod";
import { blockCount, formatCidr, parseCidr, type Cidr } from "./cidr.js";
import { err, ok, type Result } from "./result.js";

export interface LauncherConfig {
  host: string;
  port: number;
  /** variant name -> image reference. The only images a caller can select. */
  variants: ReadonlyMap<string, string>;
  pool: Cidr;
  subnetPrefix: number;
  maxConcurrentRuns: number;
  /** How the launcher finds the edge container to attach to a run network. */
  edge: { container?: string; composeService: string; composeProject?: string; alias: string };
  /** Values placed in the runner's environment. */
  runnerEnv: { edgeUrl: string; proxyUrl: string };
  limits: { memoryBytes: number; nanoCpus: number; pids: number; tmpBytes: number; stopGraceSeconds: number; uid: number; gid: number };
  /** Optional explicit docker socket path. */
  dockerSocket?: string;
  /** The Docker socket proxy (http://host:port). When set, the launcher has no socket of its own (sockproxy.ts). */
  dockerProxy?: { host: string; port: number };
  tokenFile: string;
  /** S-90: each run's /workspace is capped. `tmpfs` makes the cap hard (a size-limited volume, paid for in RAM); `disk` relies on the wrapper's measurement. */
  workspace: { maxMb: number; backing: "disk" | "tmpfs" };
  /** S-90: refuse to start new runs when the host's free disk is under `minFreeBytes`. `probePath` is any directory on the run volumes' filesystem (a small volume mounted read-only). */
  disk: { probePath?: string; minFreeBytes: number };
  /** S-93: how the concurrency was chosen, for the start-up log. */
  sizing: { source: "configured" | "derived"; hostMemBytes: number; hostCpus: number; memoryRatio: number; cpuRatio: number; reserveBytes: number };
}

/** What the host offers; the launcher reads it at start (os.totalmem is the host's memory, not the container's limit). */
export interface HostCapacity { memBytes: number; cpus: number }
export const readHostCapacity = (): HostCapacity => ({ memBytes: totalmem(), cpus: availableParallelism() });

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  LAUNCHER_HOST: z.string().min(1).default("0.0.0.0"),
  LAUNCHER_PORT: int(1, 65535).default(9100),
  LAUNCHER_TOKEN_FILE: z.string().min(1).default("/run/secrets/launcher_token"),
  RUNNER_VARIANTS: z.string().min(1).default("base=gantry-runner:dev"),
  RUN_SUBNET_POOL: z.string().min(1).default("10.213.0.0/16"),
  RUN_SUBNET_PREFIX: int(24, 29).default(28),
  // Unset (or empty): derived from the host's memory and CPUs at start (S-93). Set: checked against them, and refused when it overcommits.
  MAX_CONCURRENT_RUNS: z.preprocess((v) => (v === "" ? undefined : v), int(1, 4096).optional()),
  // The share of host memory and CPUs the runs may commit in total, as a ratio of (host - control plane). 1 = no overcommit.
  RUN_MEMORY_OVERCOMMIT_RATIO: z.coerce.number().min(0.5).max(4).default(1.5),
  RUN_CPU_OVERCOMMIT_RATIO: z.coerce.number().min(0.5).max(8).default(2),
  // What the control plane (Postgres, API, worker, edge, object store...) keeps for itself.
  CONTROL_PLANE_MEMORY_MB: int(0, 1 << 20).default(4096),
  CONTROL_PLANE_CPUS: z.coerce.number().min(0).max(256).default(1),
  MAX_CONCURRENT_RUNS_CEILING: int(1, 4096).default(32),
  WORKSPACE_MAX_MB: int(64, 1 << 22).default(10240),
  WORKSPACE_BACKING: z.enum(["disk", "tmpfs"]).default("disk"),
  MIN_FREE_DISK_GB: z.coerce.number().min(0).max(1 << 20).default(20),
  DISK_PROBE_PATH: z.string().min(1).optional(),
  // The edge's EDGE_RUN_SUBNET (compose derives both from one variable). When given, the pool must lie inside it: a run network outside the edge's
  // run subnet would make its callers "system" at the edge (S-102).
  EDGE_RUN_SUBNET: z.string().min(1).optional(),
  EDGE_CONTAINER: z.string().min(1).optional(),
  EDGE_COMPOSE_SERVICE: z.string().min(1).default("gantry-edge"),
  EDGE_COMPOSE_PROJECT: z.string().min(1).optional(),
  EDGE_ALIAS: z.string().min(1).default("gantry-edge"),
  EDGE_URL: z.string().url().default("http://gantry-edge:8443"),
  RUNNER_PROXY_URL: z.string().url().optional(),
  RUNNER_MEMORY_MB: int(64, 1 << 20).default(4096),
  RUNNER_CPUS: z.coerce.number().min(0.1).max(256).default(2),
  RUNNER_PIDS: int(16, 1 << 20).default(512),
  RUNNER_TMP_MB: int(1, 1 << 16).default(64),
  STOP_GRACE_SECONDS: int(0, 600).default(10),
  RUNNER_UID: int(1000, 65535).default(10001),
  DOCKER_SOCKET: z.string().min(1).optional(),
  DOCKER_PROXY_URL: z.string().url().optional(),
});

const VARIANT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export type ConfigError = { kind: "config"; msg: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env, host: HostCapacity = readHostCapacity()): Result<LauncherConfig, ConfigError> {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) return err({ kind: "config", msg: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const e = parsed.data;

  const variants = new Map<string, string>();
  for (const part of e.RUNNER_VARIANTS.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    const name = eq < 0 ? "" : trimmed.slice(0, eq);
    const image = eq < 0 ? "" : trimmed.slice(eq + 1);
    if (!VARIANT_NAME.test(name) || image === "" || /\s/.test(image)) return err({ kind: "config", msg: `RUNNER_VARIANTS: bad entry "${trimmed}" (want name=image)` });
    variants.set(name, image);
  }
  if (variants.size === 0) return err({ kind: "config", msg: "RUNNER_VARIANTS: no variants" });

  const pool = parseCidr(e.RUN_SUBNET_POOL);
  if (!pool) return err({ kind: "config", msg: `RUN_SUBNET_POOL: "${e.RUN_SUBNET_POOL}" is not an aligned IPv4 CIDR` });
  if (e.RUN_SUBNET_PREFIX < pool.prefix) return err({ kind: "config", msg: "RUN_SUBNET_PREFIX is larger than the pool" });
  const blocks = blockCount(pool, e.RUN_SUBNET_PREFIX);
  if (e.EDGE_RUN_SUBNET !== undefined) {
    const edgeNet = parseCidr(e.EDGE_RUN_SUBNET, { align: true });
    const span = edgeNet ? 2 ** (32 - edgeNet.prefix) : 0;
    const inside = edgeNet !== undefined && pool.prefix >= edgeNet.prefix && Math.floor(pool.base / span) === Math.floor(edgeNet.base / span);
    if (!inside) return err({ kind: "config", msg: `RUN_SUBNET_POOL ${formatCidr(pool)} is not inside the edge's EDGE_RUN_SUBNET "${e.EDGE_RUN_SUBNET}": a run from that pool would be treated as a system caller by the edge. Set both from one value.` });
  }

  // S-93: per-run limits times the concurrency must fit the host, with room left for the control plane.
  const runMemory = e.RUNNER_MEMORY_MB * 1024 * 1024;
  const reserve = e.CONTROL_PLANE_MEMORY_MB * 1024 * 1024;
  const memBudget = Math.max(0, host.memBytes - reserve) * e.RUN_MEMORY_OVERCOMMIT_RATIO;
  const cpuBudget = Math.max(0, host.cpus - e.CONTROL_PLANE_CPUS) * e.RUN_CPU_OVERCOMMIT_RATIO;
  const fitMem = Math.floor(memBudget / runMemory);
  const fitCpu = Math.floor(cpuBudget / e.RUNNER_CPUS);
  const fits = Math.min(fitMem, fitCpu);
  const gib = (n: number) => (n / 2 ** 30).toFixed(1);
  let maxConcurrentRuns: number;
  if (e.MAX_CONCURRENT_RUNS === undefined) {
    maxConcurrentRuns = Math.min(fits, e.MAX_CONCURRENT_RUNS_CEILING, blocks);
    if (maxConcurrentRuns < 1) {
      return err({ kind: "config", msg: `this host (${gib(host.memBytes)} GiB, ${host.cpus} CPUs) cannot hold one run of ${e.RUNNER_MEMORY_MB} MB and ${e.RUNNER_CPUS} CPUs beside the control plane (${e.CONTROL_PLANE_MEMORY_MB} MB, ${e.CONTROL_PLANE_CPUS} CPUs); lower RUNNER_MEMORY_MB or RUNNER_CPUS` });
    }
  } else {
    maxConcurrentRuns = e.MAX_CONCURRENT_RUNS;
    if (maxConcurrentRuns > blocks) return err({ kind: "config", msg: `MAX_CONCURRENT_RUNS ${maxConcurrentRuns} exceeds the ${blocks} subnets in ${formatCidr(pool)}` });
    if (maxConcurrentRuns * runMemory > memBudget) {
      return err({ kind: "config", msg: `MAX_CONCURRENT_RUNS ${maxConcurrentRuns} x ${e.RUNNER_MEMORY_MB} MB = ${gib(maxConcurrentRuns * runMemory)} GiB overcommits this host: ${gib(host.memBytes)} GiB minus ${e.CONTROL_PLANE_MEMORY_MB} MB for the control plane, times ratio ${e.RUN_MEMORY_OVERCOMMIT_RATIO}, allows ${gib(memBudget)} GiB (at most ${fitMem} runs). Lower MAX_CONCURRENT_RUNS or RUNNER_MEMORY_MB, or raise RUN_MEMORY_OVERCOMMIT_RATIO knowingly.` });
    }
    if (maxConcurrentRuns * e.RUNNER_CPUS > cpuBudget) {
      return err({ kind: "config", msg: `MAX_CONCURRENT_RUNS ${maxConcurrentRuns} x ${e.RUNNER_CPUS} CPUs overcommits this host: ${host.cpus} CPUs minus ${e.CONTROL_PLANE_CPUS}, times ratio ${e.RUN_CPU_OVERCOMMIT_RATIO}, allows ${cpuBudget} (at most ${fitCpu} runs). Lower MAX_CONCURRENT_RUNS or RUNNER_CPUS, or raise RUN_CPU_OVERCOMMIT_RATIO knowingly.` });
    }
  }

  const edgeUrl = e.EDGE_URL;
  const proxyUrl = e.RUNNER_PROXY_URL ?? `http://${new URL(edgeUrl).hostname}:8444`;

  const edge: LauncherConfig["edge"] = { composeService: e.EDGE_COMPOSE_SERVICE, alias: e.EDGE_ALIAS };
  if (e.EDGE_CONTAINER !== undefined) edge.container = e.EDGE_CONTAINER;
  if (e.EDGE_COMPOSE_PROJECT !== undefined) edge.composeProject = e.EDGE_COMPOSE_PROJECT;

  const cfg: LauncherConfig = {
    host: e.LAUNCHER_HOST,
    port: e.LAUNCHER_PORT,
    variants,
    pool,
    subnetPrefix: e.RUN_SUBNET_PREFIX,
    maxConcurrentRuns,
    edge,
    runnerEnv: { edgeUrl, proxyUrl },
    limits: {
      memoryBytes: e.RUNNER_MEMORY_MB * 1024 * 1024,
      nanoCpus: Math.round(e.RUNNER_CPUS * 1e9),
      pids: e.RUNNER_PIDS,
      tmpBytes: e.RUNNER_TMP_MB * 1024 * 1024,
      stopGraceSeconds: e.STOP_GRACE_SECONDS,
      uid: e.RUNNER_UID,
      gid: e.RUNNER_UID,
    },
    tokenFile: e.LAUNCHER_TOKEN_FILE,
    workspace: { maxMb: e.WORKSPACE_MAX_MB, backing: e.WORKSPACE_BACKING },
    disk: { minFreeBytes: Math.round(e.MIN_FREE_DISK_GB * 2 ** 30) },
    sizing: { source: e.MAX_CONCURRENT_RUNS === undefined ? "derived" : "configured", hostMemBytes: host.memBytes, hostCpus: host.cpus, memoryRatio: e.RUN_MEMORY_OVERCOMMIT_RATIO, cpuRatio: e.RUN_CPU_OVERCOMMIT_RATIO, reserveBytes: reserve },
  };
  if (e.DISK_PROBE_PATH !== undefined) cfg.disk.probePath = e.DISK_PROBE_PATH;
  if (e.DOCKER_SOCKET !== undefined) cfg.dockerSocket = e.DOCKER_SOCKET;
  if (e.DOCKER_PROXY_URL !== undefined) {
    const u = new URL(e.DOCKER_PROXY_URL);
    cfg.dockerProxy = { host: u.hostname, port: Number(u.port || 2375) };
  }
  return ok(cfg);
}

/** Reads the bearer token from its secret file. Strips one trailing newline; refuses short tokens. */
export async function readToken(file: string): Promise<Result<string, ConfigError>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return err({ kind: "config", msg: `launcher token file ${file} is not readable` });
  }
  const token = raw.replace(/\r?\n$/, "");
  if (token.length < 16) return err({ kind: "config", msg: "launcher token must be at least 16 characters" });
  return ok(token);
}
