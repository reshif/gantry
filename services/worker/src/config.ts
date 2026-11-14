import { loadDataKey, readSecret } from "@gantry/db";
import { parseToolchains } from "./toolchains.js";

/** Everything the worker reads from its environment and /run/secrets (docs/BUILD.md). Secrets come from files only. */
export interface WorkerConfig {
  launcherUrl: string;
  launcherToken: string;
  brokerUrl: string;
  brokerToken: string;
  /** Runner image variant the launcher is asked for (a key of the launcher's RUNNER_VARIANTS). */
  runnerVariant: string;
  smtp: { host: string; port: number; from: string; secure: boolean };
  /** Forward proxy for outbound chat and webhook traffic (spec 12.2): the edge's :8444. Null sends directly (local development only). */
  egressProxy: string | null;
  /** PEM bundle trusted for outbound HTTPS in addition to the system store. */
  egressCa: string | null;
  s3: { endpoint: string | null; bucket: string; accessKey: string; secretKey: string | null; region: string };
  heartbeatFile: string;
  /** Concurrent jobs per queue. */
  concurrency: Record<string, number>;
  jobLeaseMs: number;
  pollMs: number;
  /** Seconds until an unconfirmed termination raises an alert (spec 4.4 step 4: within 150 s of the stop). */
  terminationVerifyMs: number;
  /** Spec 4.5: how long a halted run may still checkpoint before teardown. */
  haltGraceMs: number;
  terminationPollMs: number;
  /** Margin before the reaper treats a run without a live lease as an orphan. */
  reaperGraceMs: number;
  /** Interval of the recurring jobs. */
  reaperEveryMs: number;
  reconcileEveryMs: number;
  verifyEveryMs: number;
  watchdogEveryMs: number;
  /** Time a freshly dispatched run has to send its first heartbeat before the attempt is lost (F9). */
  startupLeaseMs: number;
  /** Time the result intake keeps the attempt's lease while it publishes. */
  publishLeaseMs: number;
  maxDispatchDeferrals: number;
  dataKey: Buffer | null;
  /** Onboarding and readiness (spec 11.3). */
  /** Name of the Gantry gate check, which is not counted as CI on an onboarding pull request. */
  gateCheckName?: string;
  /** Runner variants and the ecosystems each carries, for the "runner can build and test the repo without Docker" check. */
  runnerToolchains?: Record<string, string[]>;
  /** How often a Ready repo's readiness is re-checked, and how often that re-check includes the canary (a branch and a draft pull request). */
  readinessEveryMs?: number;
  canaryEveryMs?: number;
  /** How long a verification waits for CI to report a check on the canary. */
  canaryWaitMs?: number;
}

const int = (v: string | undefined, d: number): number => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export async function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): Promise<WorkerConfig> {
  const [launcherToken, brokerToken] = await Promise.all([readSecret("launcher_token", env), readSecret("github_token", env)]);
  const dataKey = await loadDataKey(env).catch(() => null);
  const s3Secret = env.S3_ENDPOINT ? await readSecret("minio_root_password", env).catch(() => null) : null;
  return {
    launcherUrl: (env.LAUNCHER_URL || "http://gantry-launcher:9100").replace(/\/+$/, ""),
    launcherToken,
    brokerUrl: (env.GITHUB_BROKER_URL || "http://gantry-github:9200").replace(/\/+$/, ""),
    brokerToken,
    runnerVariant: env.RUNNER_VARIANT || "base",
    smtp: { host: env.SMTP_HOST || "mailpit", port: int(env.SMTP_PORT, 1025), from: env.SMTP_FROM || "Gantry <gantry@localhost>", secure: env.SMTP_SECURE === "true" },
    egressProxy: env.HTTPS_PROXY || env.https_proxy || null,
    egressCa: env.WORKER_EGRESS_CA || null,
    s3: { endpoint: env.S3_ENDPOINT || null, bucket: env.S3_BUCKET || "gantry", accessKey: env.S3_ACCESS_KEY || "gantry", secretKey: s3Secret, region: env.S3_REGION || "us-east-1" },
    heartbeatFile: env.WORKER_HEARTBEAT_FILE || "/tmp/worker-heartbeat",
    concurrency: { flow: int(env.WORKER_FLOW_CONCURRENCY, 4), stop: int(env.WORKER_STOP_CONCURRENCY, 4), github: int(env.WORKER_GITHUB_CONCURRENCY, 2), system: int(env.WORKER_SYSTEM_CONCURRENCY, 2), timers: int(env.WORKER_TIMER_CONCURRENCY, 2) },
    jobLeaseMs: int(env.WORKER_JOB_LEASE_MS, 120_000),
    pollMs: int(env.WORKER_POLL_MS, 1_000),
    terminationVerifyMs: int(env.WORKER_TERMINATION_VERIFY_MS, 150_000),
    haltGraceMs: int(env.WORKER_HALT_GRACE_MS, 20_000),
    terminationPollMs: int(env.WORKER_TERMINATION_POLL_MS, 2_000),
    reaperGraceMs: int(env.WORKER_REAPER_GRACE_MS, 5 * 60_000),
    reaperEveryMs: int(env.WORKER_REAPER_EVERY_MS, 60_000),
    reconcileEveryMs: int(env.WORKER_RECONCILE_EVERY_MS, 5 * 60_000),
    verifyEveryMs: int(env.WORKER_VERIFY_EVERY_MS, 24 * 3600_000),
    watchdogEveryMs: int(env.WORKER_WATCHDOG_EVERY_MS, 15_000),
    startupLeaseMs: int(env.WORKER_STARTUP_LEASE_MS, 180_000),
    publishLeaseMs: int(env.WORKER_PUBLISH_LEASE_MS, 15 * 60_000),
    maxDispatchDeferrals: int(env.WORKER_MAX_DISPATCH_DEFERRALS, 60),
    dataKey,
    gateCheckName: env.GITHUB_GATE_CHECK_NAME || "Gantry gates",
    runnerToolchains: parseToolchains(env.RUNNER_TOOLCHAINS),
    readinessEveryMs: int(env.WORKER_READINESS_EVERY_MS, 6 * 3600_000),
    canaryEveryMs: int(env.WORKER_CANARY_EVERY_MS, 24 * 3600_000),
    canaryWaitMs: int(env.WORKER_CANARY_WAIT_MS, 120_000),
  };
}
