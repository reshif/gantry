import { readFile } from "node:fs/promises";
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
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  LAUNCHER_HOST: z.string().min(1).default("0.0.0.0"),
  LAUNCHER_PORT: int(1, 65535).default(9100),
  LAUNCHER_TOKEN_FILE: z.string().min(1).default("/run/secrets/launcher_token"),
  RUNNER_VARIANTS: z.string().min(1).default("base=gantry-runner:dev"),
  RUN_SUBNET_POOL: z.string().min(1).default("10.213.0.0/16"),
  RUN_SUBNET_PREFIX: int(24, 29).default(28),
  MAX_CONCURRENT_RUNS: int(1, 4096).default(32),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<LauncherConfig, ConfigError> {
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
  if (e.MAX_CONCURRENT_RUNS > blocks) {
    return err({ kind: "config", msg: `MAX_CONCURRENT_RUNS ${e.MAX_CONCURRENT_RUNS} exceeds the ${blocks} subnets in ${formatCidr(pool)}` });
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
    maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
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
  };
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
