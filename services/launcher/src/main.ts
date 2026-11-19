import Docker from "dockerode";
import { readFile } from "node:fs/promises";
import { loadConfig, readToken } from "./config.js";
import { RunManager } from "./manager.js";
import { buildServer } from "./server.js";

async function main(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.ok) {
    console.error("launcher: bad configuration:", cfg.error.msg);
    return 2;
  }
  const z = cfg.value.sizing;
  console.error(`launcher: ${cfg.value.maxConcurrentRuns} concurrent runs (${z.source}) on a host of ${(z.hostMemBytes / 2 ** 30).toFixed(1)} GiB and ${z.hostCpus} CPUs; ${cfg.value.limits.memoryBytes / 2 ** 20} MB and ${cfg.value.limits.nanoCpus / 1e9} CPUs per run; control plane keeps ${(z.reserveBytes / 2 ** 30).toFixed(1)} GiB; workspace cap ${cfg.value.workspace.maxMb} MB (${cfg.value.workspace.backing}); free-disk floor ${(cfg.value.disk.minFreeBytes / 2 ** 30).toFixed(0)} GiB${cfg.value.disk.probePath ? "" : " (NOT enforced: DISK_PROBE_PATH is unset)"}`);
  const token = await readToken(cfg.value.tokenFile);
  if (!token.ok) {
    console.error("launcher:", token.error.msg);
    return 2;
  }
  // Through the socket proxy when configured (compose does): the launcher then never holds the host's Docker socket.
  const docker = new Docker(cfg.value.dockerProxy ? { protocol: "http", host: cfg.value.dockerProxy.host, port: cfg.value.dockerProxy.port } : cfg.value.dockerSocket ? { socketPath: cfg.value.dockerSocket } : undefined);
  const manager = new RunManager(docker, cfg.value);
  manager.startDiskMonitor();
  // Optional: when the metrics_token secret exists, a scraper outside the internal network may use it.
  const metricsToken = await readFile(process.env.METRICS_TOKEN_FILE || "/run/secrets/metrics_token", "utf8").then((t) => t.replace(/\r?\n$/, "") || null, () => null);
  const app = buildServer({ cfg: cfg.value, manager, token: token.value, metricsToken });

  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ host: cfg.value.host, port: cfg.value.port });
  return -1; // keep running
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error("launcher: failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
