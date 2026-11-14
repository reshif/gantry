import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface EdgeConfig {
  apiUrl: string;
  edgeToken: string;
  /** Vendor id -> API key, from /run/secrets/vendor_keys.json. */
  vendorKeys: Record<string, string>;
  modelPort: number;
  proxyPort: number;
  s3: S3Config | null;
  /** Calls in flight to one vendor at once; the rest queue (spec 10.4 rate-limit handling). */
  vendorConcurrency: number;
  /** How long a call may wait for a vendor slot or a vendor cooldown before it is answered 429 with Retry-After. */
  queueWaitMs: number;
  apiTimeoutMs: number;
  vendorTimeoutMs: number;
  /** How long a project's outbound allow-list is cached (spec 5.3: fetched from the API, cached briefly; under the 10 s stop target of spec 4.4). */
  allowlistTtlMs: number;
  /** How often established CONNECT tunnels of a run are re-checked against the API; a refused run has all its tunnels cut (spec 4.4: revoked token, stop). 0 turns the check off. */
  tunnelCheckMs: number;
  /** Source addresses inside this CIDR are runners and must present their run token to the proxy; everything else is system (worker). */
  runSubnet: string;
  /** Ports the proxy will connect to. */
  allowedPorts: number[];
  /** Refuse upstream addresses that are loopback, link-local or private (SSRF guard). Off only in tests. */
  blockPrivateAddresses: boolean;
  /** Largest model request body accepted. */
  maxBodyBytes: number;
  /** Largest response body kept for trace capture; a longer one is truncated in the trace (never in the stream). */
  maxTraceBytes: number;
  /** How long one call to an MCP server may take, connecting included (spec 12.4). Default 30 s. */
  mcpTimeoutMs?: number;
}

export class SecretError extends Error {}

export async function readSecretFile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = env.GANTRY_SECRETS_DIR && env.GANTRY_SECRETS_DIR.length > 0 ? env.GANTRY_SECRETS_DIR : "/run/secrets";
  let raw: string;
  try {
    raw = await readFile(join(dir, name), "utf8");
  } catch (e) {
    throw new SecretError(`secret ${name} is ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"}`);
  }
  const v = raw.replace(/\r?\n$/, "");
  if (!v) throw new SecretError(`secret ${name} is empty`);
  return v;
}

const VendorKeys = z.record(z.string(), z.union([z.string(), z.object({ apiKey: z.string() }).transform((o) => o.apiKey)]));

export function parseVendorKeys(text: string): Record<string, string> {
  const p = VendorKeys.parse(JSON.parse(text));
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v.length > 0));
}

const Env = z.object({
  GANTRY_API_URL: z.string().url().default("http://gantry-api:8000"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().default("gantry"),
  S3_ACCESS_KEY: z.string().default("gantry"),
  S3_REGION: z.string().default("us-east-1"),
  EDGE_MODEL_PORT: z.coerce.number().int().default(8443),
  EDGE_PROXY_PORT: z.coerce.number().int().default(8444),
  EDGE_VENDOR_CONCURRENCY: z.coerce.number().int().positive().default(16),
  EDGE_RUN_SUBNET: z.string().default("10.213.0.0/16"),
  /** Sandbox and test stacks only: lets the proxy and the MCP gateway reach private addresses (fake Slack and MCP servers in the compose network). Never set in a real install. */
  EDGE_ALLOW_PRIVATE_UPSTREAMS: z.enum(["true", "false"]).default("false"),
});

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<EdgeConfig> {
  const e = Env.parse(env);
  const edgeToken = await readSecretFile("edge_token", env);
  const vendorKeys = parseVendorKeys(await readSecretFile("vendor_keys.json", env).catch(() => "{}"));
  const s3 = e.S3_ENDPOINT ? { endpoint: e.S3_ENDPOINT, bucket: e.S3_BUCKET, accessKey: e.S3_ACCESS_KEY, secretKey: await readSecretFile("minio_root_password", env).catch(() => ""), region: e.S3_REGION } : null;
  return {
    apiUrl: e.GANTRY_API_URL.replace(/\/+$/, ""),
    edgeToken,
    vendorKeys,
    modelPort: e.EDGE_MODEL_PORT,
    proxyPort: e.EDGE_PROXY_PORT,
    s3: s3 && s3.secretKey ? s3 : null,
    vendorConcurrency: e.EDGE_VENDOR_CONCURRENCY,
    queueWaitMs: 30_000,
    apiTimeoutMs: 10_000,
    vendorTimeoutMs: 600_000,
    // Spec 4.4 step 2: a stopped run is refused within 10 s, so a cached allow-list must not outlive that.
    allowlistTtlMs: 5_000,
    tunnelCheckMs: 3_000,
    runSubnet: e.EDGE_RUN_SUBNET,
    allowedPorts: [80, 443],
    blockPrivateAddresses: e.EDGE_ALLOW_PRIVATE_UPSTREAMS !== "true",
    maxBodyBytes: 32 * 1024 * 1024,
    maxTraceBytes: 16 * 1024 * 1024,
  };
}
