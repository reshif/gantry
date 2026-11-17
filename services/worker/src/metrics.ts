/**
 * Prometheus metrics for the worker: what it did (jobs by kind and outcome, how long they took, deliveries by transport) and its own loop.
 * Factory-wide state (queue depth, stuck jobs, spend, dead letters) is read from the database by the API's /metrics, so it is not repeated here.
 * The worker serves /metrics on its own small port, on the control network only: an internal peer that did not come through a proxy, or a metrics token.
 */
import { createServer, type Server } from "node:http";
import { readSecretOptional } from "@gantry/db";
import { METRICS_CONTENT_TYPE, MetricsRegistry, metricsAllowed } from "@gantry/domain";

export const registry = new MetricsRegistry();
const started = Date.now();

export const jobsTotal = registry.counter("gantry_worker_jobs_total", "Jobs the worker finished, by kind and outcome (done, retried, dead, lost).");
export const jobSeconds = registry.histogram("gantry_worker_job_duration_seconds", "How long jobs ran, by kind.", [0.05, 0.25, 1, 5, 30, 120, 600]);
export const deliveriesTotal = registry.counter("gantry_worker_deliveries_total", "Outgoing notifications attempted, by transport and outcome (sent, retried, dead).");
const up = registry.gauge("gantry_worker_up", "1 while the worker process is running.");
const uptime = registry.gauge("gantry_worker_uptime_seconds", "Seconds since the worker started.");
up.set(1);
registry.collect(() => uptime.set(Math.round((Date.now() - started) / 1000)));

export const transportOf = (destination: string): string => destination.split(":")[0] || "unknown";

export async function startMetricsServer(port: number, host = "0.0.0.0", tokens?: readonly (string | null)[]): Promise<Server | null> {
  if (port <= 0) return null;
  const accepted = tokens ?? [await readSecretOptional("metrics_token")];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404, { "content-type": "application/json" }).end('{"ok":false}');
      return;
    }
    if (!metricsAllowed({ remoteAddress: req.socket.remoteAddress, headers: req.headers, tokens: accepted })) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end('{"ok":false,"msg":"Metrics are for the internal network or a metrics token."}');
      return;
    }
    registry.render().then(
      (body) => res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
