/**
 * Prometheus metrics for the API: request rate, latency and errors, plus the factory's own state read from the database at scrape time
 * (queue depth, stuck jobs, run outcomes, spend, outbox dead letters, backup age, budget halts).
 * `/metrics` is outside /api/v1 and never reachable through the ingress: it answers a peer on the internal network that did not come
 * through a proxy, or a caller holding the metrics token (secret `metrics_token`).
 */
import type { FastifyInstance } from "fastify";
import { METRICS_CONTENT_TYPE, MetricsRegistry, metricsAllowed } from "@gantry/domain";
import { readSecretOptional, type Queryable } from "@gantry/db";
import { RUNNING_LONG_MINUTES, readBackup, readDrill } from "../areas/system/health.js";

export interface MetricsDeps {
  pool: Queryable;
  orgId: string;
  backupsDir: string;
  /** Accepted bearer tokens besides the internal network. */
  tokens: readonly (string | null)[];
}

const statusClass = (code: number): string => `${Math.floor(code / 100)}xx`;

export function createApiMetrics(d: MetricsDeps): MetricsRegistry {
  const r = new MetricsRegistry();
  const { pool, orgId } = d;
  const jobs = r.gauge("gantry_jobs", "Background jobs by status.");
  const queued = r.gauge("gantry_jobs_queue_depth", "Jobs that are due now and waiting for a worker, by queue.");
  const oldest = r.gauge("gantry_jobs_oldest_due_seconds", "How long the oldest due job has been waiting (0 when none).");
  const stuck = r.gauge("gantry_jobs_stuck", "Running jobs whose lease expired or that have run longer than the long-running limit.");
  const runs = r.gauge("gantry_runs_finished_24h", "Runs that ended in the last 24 hours, by outcome.");
  const spend = r.gauge("gantry_spend_month_micros", "Model spend this calendar month, in millionths of a dollar (all projects).");
  const budgetUse = r.gauge("gantry_budget_used_ratio", "This month's spend as a share of the project's monthly budget, for projects that have one.");
  const halts = r.gauge("gantry_budget_halts_active", "Work orders currently halted because they reached their spending cap.");
  const factoryHalted = r.gauge("gantry_factory_halted", "1 while the whole factory is halted or killed.");
  const outbox = r.gauge("gantry_outbox", "Outgoing notifications by status.");
  const dead = r.gauge("gantry_outbox_dead_letters", "Notifications that failed every attempt and need a person.");
  const hb = r.gauge("gantry_worker_heartbeat_age_seconds", "Seconds since the newest worker heartbeat (absent when none was ever recorded).");
  const backupAge = r.gauge("gantry_backup_age_seconds", "Age of the newest backup (absent when no backup status exists).");
  const backupOk = r.gauge("gantry_backup_last_ok", "1 when the last backup attempt succeeded.");
  const drillOk = r.gauge("gantry_restore_drill_last_ok", "1 when the last restore drill passed (absent when none was recorded).");
  const up = r.gauge("gantry_database_up", "1 when the API can reach its database.");
  up.set(1);

  r.collect(async () => {
    const now = new Date();
    try {
      const [j, q, s, ru, sp, bu, h, o, w] = await Promise.all([
        pool.query<{ status: string; n: number }>(`select status, count(*)::int as n from jobs where org_id = $1 group by status`, [orgId]),
        pool.query<{ queue: string; n: number; oldest: number | null }>(
          `select queue, count(*)::int as n, extract(epoch from (now() - min(run_at)))::float as oldest from jobs where org_id = $1 and status = 'queued' and run_at <= now() group by queue`, [orgId]),
        pool.query<{ n: number }>(
          `select count(*)::int as n from jobs where org_id = $1 and status = 'running' and (lease_until < now() or started_at < now() - make_interval(mins => $2))`, [orgId, RUNNING_LONG_MINUTES]),
        pool.query<{ state: string; n: number }>(
          `select state, count(*)::int as n from runs where org_id = $1 and ended_at > now() - interval '24 hours' group by state`, [orgId]),
        pool.query<{ micros: string }>(
          `select coalesce(sum(cost_micros), 0)::text as micros from usage_meter where org_id = $1 and at >= date_trunc('month', now())`, [orgId]),
        pool.query<{ project_id: string; ratio: number }>(
          `select b.project_id, (coalesce(sum(u.cost_micros), 0)::float / b.monthly_limit_micros) as ratio
             from budgets b left join usage_meter u on u.org_id = b.org_id and u.project_id = b.project_id and u.at >= date_trunc('month', now())
            where b.org_id = $1 and b.monthly_limit_micros > 0 group by b.project_id, b.monthly_limit_micros`, [orgId]),
        pool.query<{ budget: number; factory: number }>(
          `select count(*) filter (where cause = 'budget')::int as budget, count(*) filter (where scope_type = 'factory')::int as factory from stops where org_id = $1 and lifted_at is null`, [orgId]),
        pool.query<{ status: string; n: number }>(`select status, count(*)::int as n from outbox where org_id = $1 group by status`, [orgId]),
        pool.query<{ age: number | null }>(`select extract(epoch from (now() - max(seen_at)))::float as age from worker_heartbeats where org_id = $1`, [orgId]),
      ]);
      up.set(1);
      for (const g of [jobs, queued, oldest, runs, budgetUse, outbox]) g.clear();
      for (const st of ["queued", "running", "done", "dead"]) jobs.set(j.rows.find((x) => x.status === st)?.n ?? 0, { status: st });
      if (!q.rows.length) queued.set(0, { queue: "default" });
      for (const x of q.rows) queued.set(x.n, { queue: x.queue });
      oldest.set(Math.max(0, ...q.rows.map((x) => x.oldest ?? 0)));
      stuck.set(s.rows[0]?.n ?? 0);
      for (const st of ["succeeded", "failed", "stopped", "reaped"]) runs.set(ru.rows.find((x) => x.state === st)?.n ?? 0, { outcome: st });
      spend.set(Number(sp.rows[0]?.micros ?? 0));
      for (const x of bu.rows) budgetUse.set(Math.round(x.ratio * 1000) / 1000, { project: x.project_id });
      halts.set(h.rows[0]?.budget ?? 0);
      factoryHalted.set((h.rows[0]?.factory ?? 0) > 0 ? 1 : 0);
      for (const st of ["pending", "sending", "delivered", "dead"]) outbox.set(o.rows.find((x) => x.status === st)?.n ?? 0, { status: st });
      dead.set(o.rows.find((x) => x.status === "dead")?.n ?? 0);
      hb.clear();
      if (w.rows[0]?.age != null) hb.set(Math.max(0, w.rows[0].age));
    } catch {
      up.set(0);
    }
    const [b, dr] = await Promise.all([readBackup(d.backupsDir, now), readDrill(d.backupsDir, now)]);
    backupAge.clear();
    backupOk.clear();
    drillOk.clear();
    if (b.status !== "unknown" || b.ageHours !== null) {
      if (b.ageHours !== null) backupAge.set(b.ageHours * 3600);
      backupOk.set(b.status === "failed" ? 0 : 1);
    }
    if (dr.status !== "unknown") drillOk.set(dr.status === "ok" ? 1 : 0);
  });
  return r;
}

/** Counts every request by method, route pattern and status class, times it, and serves /metrics. */
export async function registerMetrics(app: FastifyInstance, d: Omit<MetricsDeps, "tokens"> & { tokens?: readonly (string | null)[] }): Promise<MetricsRegistry> {
  const tokens = d.tokens ?? [await readSecretOptional("metrics_token")];
  const reg = createApiMetrics({ ...d, tokens });
  const requests = reg.counter("gantry_http_requests_total", "API requests by method, route and status class.");
  const errors = reg.counter("gantry_http_errors_total", "API requests that ended in a server error (5xx), by route.");
  const latency = reg.histogram("gantry_http_request_duration_seconds", "API request time in seconds, by method and route.");

  app.addHook("onResponse", async (req, reply) => {
    // The route pattern, never the raw path: an unmatched path (a scan) is one series, not one per URL.
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics" || route === "/healthz") return;
    requests.inc({ method: req.method, route, status: statusClass(reply.statusCode) });
    if (reply.statusCode >= 500) errors.inc({ route });
    latency.observe(reply.elapsedTime / 1000, { method: req.method, route });
  });

  app.get("/metrics", { config: { rateLimit: false }, logLevel: "warn" }, async (req, reply) => {
    if (!metricsAllowed({ remoteAddress: req.socket.remoteAddress, headers: req.headers, tokens })) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ ok: false, msg: "Metrics are for the internal network or a metrics token." });
    }
    return reply.header("content-type", METRICS_CONTENT_TYPE).send(await reg.render());
  });
  return reg;
}
