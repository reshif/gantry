/**
 * System health (admin view): what is running, whether backups and the restore drill are current, the outbox and its dead letters, and jobs that look stuck.
 * Read only. Services are probed on their own /healthz with a short timeout (the URLs come from the deployment environment, never from a request).
 * The worker has no endpoint of its own: it records a heartbeat row every few seconds (worker_heartbeats) and the view shows that age; the queue
 * (work that is due and not being picked up) is a second signal. Backup and drill status are the
 * small JSON files the backup service writes, read from a read-only mount of the backups volume.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Queryable } from "@gantry/db";

export type ServiceStatus = "ok" | "degraded" | "down" | "unknown";
export interface ServiceHealth { id: string; name: string; status: ServiceStatus; detail: string; latencyMs: number | null; /** Worker only: seconds since its last heartbeat (null when none was ever recorded). */ heartbeatAgeSeconds?: number | null }
export type Probe = (url: string) => Promise<{ ok: boolean; status: number; ms: number; body?: unknown }>;

/** A backup older than this is stale (the backup service itself reports unhealthy at the same age). */
export const BACKUP_STALE_HOURS = 26;
/** A running job past this without finishing is flagged for a person to look at (its lease may still be renewing). */
export const RUNNING_LONG_MINUTES = 120;
/** Work that was due this long ago and is still queued, with nothing running, means no worker is taking jobs. */
export const WORKER_OVERDUE_SECONDS = 120;
/** The worker beats every 5 s: a heartbeat this old is late, and this old means it is gone. */
export const HEARTBEAT_LATE_SECONDS = 30;
export const HEARTBEAT_DOWN_SECONDS = 90;
/** Run starts that failed within this window are a problem to show (a run that never got going: workspace seeding, the launcher, a missing model). */
export const RUN_START_WINDOW_MINUTES = 30;
/** This many failed run starts in the window means station runs are not starting at all; fewer is a warning. */
export const RUN_START_DOWN_AT = 3;
/** Jobs that died within this many hours are listed with their reason and make the background jobs service unhealthy. */
export const DEAD_JOB_WINDOW_HOURS = 24;

export interface BackupStatus { status: "ok" | "stale" | "failed" | "unknown"; at: string | null; ageHours: number | null; set: string | null; detail: string }
export interface DrillStatus { status: "ok" | "failed" | "unknown"; at: string | null; ageHours: number | null; set: string | null; seconds: number | null; failedChecks: number; detail: string }

export interface Targets { edge: string; broker: string; objectStore: string }

export function targetsFromEnv(env: NodeJS.ProcessEnv = process.env): Targets {
  const u = (v: string | undefined, d: string): string => (v || d).replace(/\/+$/, "");
  return {
    edge: u(env.EDGE_URL, "http://gantry-edge:8443"),
    broker: u(env.GITHUB_BROKER_URL, "http://gantry-github:9200"),
    objectStore: u(env.S3_ENDPOINT, "http://minio:9000"),
  };
}

/** The real probe: GET with a 2 s timeout, never following redirects. A failure is a result, not an exception. */
export const httpProbe: Probe = async (url) => {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - t0 };
  }
};

async function probeService(probe: Probe, id: string, name: string, url: string, check?: (body: unknown) => { status: ServiceStatus; detail: string } | null): Promise<ServiceHealth> {
  const r = await probe(url);
  if (!r.ok) return { id, name, status: "down", detail: r.status ? `Answered ${r.status}.` : "No answer.", latencyMs: null };
  const custom = check?.(r.body);
  return { id, name, status: custom?.status ?? "ok", detail: custom?.detail ?? "Answering.", latencyMs: r.ms };
}

/** Reads one of the backup service's status files; absent, unreadable or malformed is `null` (shown as unknown). */
async function readStatusFile(dir: string, file: string): Promise<{ json: Record<string, unknown>; mtime: Date } | null> {
  try {
    const p = join(dir, file);
    const [raw, st] = await Promise.all([readFile(p, "utf8"), stat(p)]);
    const json = JSON.parse(raw) as unknown;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return { json: json as Record<string, unknown>, mtime: st.mtime };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v.slice(0, 120) : null);
const hoursSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10) : null;
};

export async function readBackup(dir: string, now: Date): Promise<BackupStatus> {
  const f = await readStatusFile(dir, "last-backup.json");
  if (!f) return { status: "unknown", at: null, ageHours: null, set: null, detail: "No backup status found. The backup service may not be running." };
  const at = str(f.json.at) ?? f.mtime.toISOString();
  const age = hoursSince(at, now);
  const set = str(f.json.set);
  if (f.json.ok !== true) return { status: "failed", at, ageHours: age, set, detail: "The last backup attempt failed. Check the backup service log." };
  if (age === null) return { status: "unknown", at, ageHours: null, set, detail: "The backup time could not be read." };
  if (age > BACKUP_STALE_HOURS) return { status: "stale", at, ageHours: age, set, detail: `The newest backup is ${Math.floor(age)} hours old. A daily backup should never pass ${BACKUP_STALE_HOURS}.` };
  return { status: "ok", at, ageHours: age, set, detail: "The newest backup succeeded." };
}

export async function readDrill(dir: string, now: Date): Promise<DrillStatus> {
  const f = await readStatusFile(dir, "last-drill.json");
  if (!f) return { status: "unknown", at: null, ageHours: null, set: null, seconds: null, failedChecks: 0, detail: "No restore drill has been recorded yet." };
  const at = str(f.json.at) ?? f.mtime.toISOString();
  const checks = Array.isArray(f.json.checks) ? f.json.checks : [];
  const failedChecks = checks.filter((c) => c && typeof c === "object" && (c as { ok?: unknown }).ok === false).length;
  const seconds = typeof f.json.seconds === "number" && Number.isFinite(f.json.seconds) ? f.json.seconds : null;
  const ok = f.json.ok === true;
  return {
    status: ok ? "ok" : "failed", at, ageHours: hoursSince(at, now), set: str(f.json.set), seconds, failedChecks,
    detail: ok ? "The last restore drill passed." : "The last restore drill failed. A backup that cannot be restored is not a backup.",
  };
}

export interface DeadLetter { id: string; destination: string; /** "project" rows belong to one project's notifications: only the transport and a generic reason are shown here. */ scope: "factory" | "project"; attempts: number; maxAttempts: number; lastError: string | null; createdAt: string; failedAt: string }
export interface StuckJob { id: string; queue: string; kind: string; attempts: number; maxAttempts: number; owner: string | null; startedAt: string | null; leaseUntil: string | null; reason: "lease_expired" | "running_long"; lastError: string | null }
export interface DeadJob { id: string; queue: string; kind: string; attempts: number; maxAttempts: number; lastError: string | null; diedAt: string }
export interface RunStartFailure { code: string; reason: string; count: number; lastAt: string }
export interface Health {
  at: string;
  services: ServiceHealth[];
  backup: BackupStatus;
  drill: DrillStatus;
  outbox: { counts: Record<"pending" | "sending" | "delivered" | "dead", number>; oldestPendingSeconds: number | null; dead: DeadLetter[] };
  jobs: { counts: Record<"queued" | "running" | "done" | "dead", number>; stuck: StuckJob[]; runningLongMinutes: number; /** Jobs that died in the last DEAD_JOB_WINDOW_HOURS, newest first, with the reason. */ dead: DeadJob[]; deadWindowHours: number };
  /** Station runs that failed to start in the last RUN_START_WINDOW_MINUTES, grouped by the reason recorded on the run. */
  runStarts: { windowMinutes: number; failed: number; reasons: RunStartFailure[] };
}

export interface HealthDeps { pool: Queryable; orgId: string; probe: Probe; targets: Targets; backupsDir: string; now?: Date }

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
const clip = (v: unknown, n = 300): string | null => (typeof v === "string" && v ? v.slice(0, n) : null);

/**
 * Delivery errors come from transport responses and may echo a webhook URL, an address or a token. This view is factory-level, so it never shows them raw:
 * URLs, addresses and long token-like strings are masked. A project's own deliveries show only a generic reason (their detail is in that project's delivery log).
 */
export function redactError(v: unknown, projectScoped: boolean, n = 200): string | null {
  if (typeof v !== "string" || !v) return null;
  if (projectScoped) {
    const code = /\b([1-5]\d\d)\b/.exec(v)?.[1];
    return code ? `Delivery failed (HTTP ${code}). See the project's delivery log.` : "Delivery failed. See the project's delivery log.";
  }
  return v
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[address]")
    .replace(/\b[A-Za-z0-9_\-+/=]{24,}\b/g, "[redacted]")
    .slice(0, n);
}
/** A destination key is `transport:instance:target` and the target can be a channel or address: this view shows the transport, and the instance for factory rows. */
export function shownDestination(dest: string, projectScoped: boolean): string {
  const [transport = dest, instance] = dest.split(":");
  return projectScoped || !instance ? transport : `${transport}:${instance}`;
}

async function dbService(pool: Queryable): Promise<ServiceHealth> {
  const t0 = Date.now();
  try {
    await pool.query("select 1");
    return { id: "db", name: "Database", status: "ok", detail: "Answering.", latencyMs: Date.now() - t0 };
  } catch {
    return { id: "db", name: "Database", status: "down", detail: "No answer.", latencyMs: null };
  }
}

/** The launcher sits on a network the API is not on, so its health is what the worker last saw (worker_heartbeats.launcher_*). */
async function launcherService(pool: Queryable, orgId: string, now: Date): Promise<ServiceHealth> {
  const base = { id: "launcher", name: "Run launcher", latencyMs: null };
  try {
    const r = await pool.query<{ ok: boolean | null; at: Date | null }>(
      `select launcher_ok as ok, launcher_checked_at as at from worker_heartbeats where org_id = $1 and launcher_checked_at is not null order by launcher_checked_at desc limit 1`, [orgId]);
    const row = r.rows[0];
    if (!row || row.ok === null || !row.at) return { ...base, status: "unknown", detail: "No worker has reported on the launcher yet." };
    const age = Math.max(0, Math.round((now.getTime() - row.at.getTime()) / 1000));
    if (age > HEARTBEAT_DOWN_SECONDS) return { ...base, status: "unknown", detail: `The worker last checked the launcher ${Math.round(age / 60)} min ago.` };
    return row.ok ? { ...base, status: "ok", detail: "Answering the worker." } : { ...base, status: "down", detail: "Not answering the worker." };
  } catch {
    return { ...base, status: "unknown", detail: "The launcher report could not be read." };
  }
}

async function workerService(pool: Queryable, orgId: string, now: Date): Promise<ServiceHealth> {
  const name = "Worker";
  try {
    const hb = await pool.query<{ seen: Date | null }>(`select max(seen_at) as seen from worker_heartbeats where org_id = $1`, [orgId]);
    const seen = hb.rows[0]?.seen ?? null;
    const age = seen ? Math.max(0, Math.round((now.getTime() - seen.getTime()) / 1000)) : null;
    const q = await pool.query<{ overdue: number; oldest: Date | null; running: number }>(
      `select count(*) filter (where status = 'queued' and run_at < $2::timestamptz - make_interval(secs => $3))::int as overdue,
              min(run_at) filter (where status = 'queued' and run_at < $2::timestamptz - make_interval(secs => $3)) as oldest,
              count(*) filter (where status = 'running' and lease_until > $2::timestamptz)::int as running
         from jobs where org_id = $1 and status in ('queued','running')`,
      [orgId, now, WORKER_OVERDUE_SECONDS],
    );
    const row = q.rows[0]!;
    const jobs = (n: number): string => `${n} job${n === 1 ? " is" : "s are"}`;
    const ageText = age === null ? "" : age < 120 ? `${age} s` : `${Math.round(age / 60)} min`;
    const ageMin = row.oldest ? Math.max(1, Math.round((now.getTime() - row.oldest.getTime()) / 60_000)) : 0;
    const out = (status: ServiceStatus, detail: string): ServiceHealth => ({ id: "worker", name, status, detail, latencyMs: null, heartbeatAgeSeconds: age });
    if (age === null) {
      return row.overdue > 0 && row.running === 0
        ? out("down", `No heartbeat has been recorded and ${jobs(row.overdue)} due with none running.`)
        : out("unknown", "No worker has recorded a heartbeat yet. A worker from before heartbeats were added reports nothing here.");
    }
    if (age > HEARTBEAT_DOWN_SECONDS) return out("down", `Last heartbeat ${ageText} ago.${row.overdue > 0 ? ` ${jobs(row.overdue)} waiting, the oldest for ${ageMin} min.` : ""}`);
    if (age > HEARTBEAT_LATE_SECONDS) return out("degraded", `Heartbeat is late: ${ageText} ago.`);
    if (row.overdue > 0 && row.running === 0) return out("degraded", `Alive (heartbeat ${ageText} ago) but ${jobs(row.overdue)} due and none is running. The oldest has waited ${ageMin} min.`);
    if (row.overdue > 0) return out("degraded", `Heartbeat ${ageText} ago. ${jobs(row.overdue)} overdue while ${row.running} run.`);
    return out("ok", `Heartbeat ${ageText} ago. Queue is on time.`);
  } catch {
    return { id: "worker", name, status: "unknown", detail: "The worker heartbeat could not be read.", latencyMs: null, heartbeatAgeSeconds: null };
  }
}

/** Failed run starts in the window, grouped by their recorded reason. The worker writes `dispatchError` on the run when it gives up starting it. */
async function runStartFailures(pool: Queryable, orgId: string, now: Date): Promise<Health["runStarts"]> {
  const r = await pool.query<{ code: string | null; msg: string | null; n: number; last: Date }>(
    `select data->'dispatchError'->>'code' as code, data->'dispatchError'->>'msg' as msg, count(*)::int as n, max(ended_at) as last
       from runs where org_id = $1 and data->>'endedBy' = 'dispatch failed' and ended_at >= $2::timestamptz - make_interval(mins => $3)
      group by 1, 2 order by max(ended_at) desc limit 10`,
    [orgId, now, RUN_START_WINDOW_MINUTES],
  );
  const reasons = r.rows.map((x) => ({ code: x.code ?? "dispatch_error", reason: redactError(x.msg ?? "The run could not be started.", false, 240) ?? "The run could not be started.", count: x.n, lastAt: iso(x.last)! }));
  return { windowMinutes: RUN_START_WINDOW_MINUTES, failed: reasons.reduce((a, x) => a + x.count, 0), reasons };
}

export function runStartsService(rs: Health["runStarts"]): ServiceHealth {
  const base = { id: "run-starts", name: "Run starts", latencyMs: null };
  if (rs.failed === 0) return { ...base, status: "ok", detail: `No run failed to start in the last ${rs.windowMinutes} min.` };
  const top = rs.reasons[0]!;
  return { ...base, status: rs.failed >= RUN_START_DOWN_AT ? "down" : "degraded", detail: `${rs.failed} run start${rs.failed === 1 ? "" : "s"} failed in the last ${rs.windowMinutes} min. Latest: ${top.reason}` };
}

export function deadJobsService(dead: DeadJob[], windowHours: number): ServiceHealth {
  const base = { id: "jobs", name: "Background jobs", latencyMs: null };
  if (!dead.length) return { ...base, status: "ok", detail: `No job died in the last ${windowHours} hours.` };
  const top = dead[0]!;
  return { ...base, status: "degraded", detail: `${dead.length} job${dead.length === 1 ? "" : "s"} died in the last ${windowHours} hours. Latest: ${top.kind}${top.lastError ? `: ${top.lastError}` : ""}` };
}

export async function collectHealth(d: HealthDeps): Promise<Health> {
  const now = d.now ?? new Date();
  const { pool, orgId } = d;
  const [db, edge, broker, objects, worker, backup, drill, launcher] = await Promise.all([
    dbService(pool),
    probeService(d.probe, "edge", "Edge gateway", `${d.targets.edge}/healthz`),
    probeService(d.probe, "github", "GitHub broker", `${d.targets.broker}/healthz`, (b) => {
      const o = (b ?? {}) as { configured?: unknown; reason?: unknown };
      return o.configured === false ? { status: "degraded", detail: clip(o.reason, 160) ?? "The GitHub App is not configured." } : null;
    }),
    probeService(d.probe, "objects", "Object store", `${d.targets.objectStore}/minio/health/live`),
    workerService(pool, orgId, now),
    readBackup(d.backupsDir, now),
    readDrill(d.backupsDir, now),
    launcherService(pool, orgId, now),
  ]);
  const api: ServiceHealth = { id: "api", name: "API", status: "ok", detail: "Answering this request.", latencyMs: null };

  const [ob, obCounts, jobCounts, stuck, deadJobs, runStarts] = await Promise.all([
    pool.query<{ id: string; destination: string; attempts: number; max_attempts: number; last_error: string | null; created_at: Date; updated_at: Date; project_id: string | null }>(
      `select o.id, o.destination, o.attempts, o.max_attempts, o.last_error, o.created_at, o.updated_at, e.project_id
         from outbox o join events e on e.id = o.event_id where o.org_id = $1 and o.status = 'dead' order by o.updated_at desc, o.id limit 20`, [orgId]),
    pool.query<{ status: string; n: number; oldest: Date | null }>(
      `select status, count(*)::int as n, min(created_at) filter (where status = 'pending') as oldest from outbox where org_id = $1 group by status`, [orgId]),
    pool.query<{ status: string; n: number }>(`select status, count(*)::int as n from jobs where org_id = $1 group by status`, [orgId]),
    pool.query<{ id: string; queue: string; kind: string; attempts: number; max_attempts: number; lease_owner: string | null; started_at: Date | null; lease_until: Date | null; last_error: string | null; expired: boolean }>(
      `select id, queue, kind, attempts, max_attempts, lease_owner, started_at, lease_until, last_error, (lease_until < $2::timestamptz) as expired
         from jobs where org_id = $1 and status = 'running' and (lease_until < $2::timestamptz or started_at < $2::timestamptz - make_interval(mins => $3))
        order by coalesce(started_at, lease_until) limit 50`, [orgId, now, RUNNING_LONG_MINUTES]),
    pool.query<{ id: string; queue: string; kind: string; attempts: number; max_attempts: number; last_error: string | null; died: Date }>(
      `select id, queue, kind, attempts, max_attempts, last_error, coalesce(completed_at, updated_at) as died
         from jobs where org_id = $1 and status = 'dead' and coalesce(completed_at, updated_at) >= $2::timestamptz - make_interval(hours => $3)
        order by coalesce(completed_at, updated_at) desc, id limit 20`, [orgId, now, DEAD_JOB_WINDOW_HOURS]),
    runStartFailures(pool, orgId, now),
  ]);
  const dead: DeadJob[] = deadJobs.rows.map((r) => ({ id: r.id, queue: r.queue, kind: r.kind, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: redactError(r.last_error, false), diedAt: iso(r.died)! }));
  const oc: Health["outbox"]["counts"] = { pending: 0, sending: 0, delivered: 0, dead: 0 };
  let oldest: Date | null = null;
  for (const r of obCounts.rows) {
    if (r.status in oc) oc[r.status as keyof typeof oc] = r.n;
    if (r.oldest) oldest = r.oldest;
  }
  const jc: Health["jobs"]["counts"] = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const r of jobCounts.rows) if (r.status in jc) jc[r.status as keyof typeof jc] = r.n;

  return {
    at: now.toISOString(),
    services: [api, db, objects, edge, worker, broker, launcher, runStartsService(runStarts), deadJobsService(dead, DEAD_JOB_WINDOW_HOURS)],
    backup, drill,
    outbox: {
      counts: oc,
      oldestPendingSeconds: oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null,
      dead: ob.rows.map((r) => ({ id: r.id, destination: shownDestination(r.destination, !!r.project_id), scope: r.project_id ? "project" as const : "factory" as const, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: redactError(r.last_error, !!r.project_id), createdAt: iso(r.created_at)!, failedAt: iso(r.updated_at)! })),
    },
    jobs: {
      counts: jc, runningLongMinutes: RUNNING_LONG_MINUTES, dead, deadWindowHours: DEAD_JOB_WINDOW_HOURS,
      stuck: stuck.rows.map((r) => ({ id: r.id, queue: r.queue, kind: r.kind, attempts: r.attempts, maxAttempts: r.max_attempts, owner: r.lease_owner, startedAt: iso(r.started_at), leaseUntil: iso(r.lease_until), reason: r.expired ? "lease_expired" : "running_long", lastError: redactError(r.last_error, false) })),
    },
    runStarts,
  };
}
