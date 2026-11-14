import { createPool } from "@gantry/db";
import pino from "pino";
import { ensureBucket } from "./bucket.js";
import { loadWorkerConfig } from "./config.js";
import { Worker, buildDeps } from "./worker.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", redact: ["*.authorization", "*.token", "*.runToken"] });
const cfg = await loadWorkerConfig();
const pool = createPool("app", { applicationName: "gantry-worker", max: 20 });
pool.on("error", (e) => log.error({ err: e.message }, "idle database client error"));

// Not awaited: jobs must not wait for object storage; the edge reports a missing bucket itself.
void ensureBucket(cfg, log);
const worker = new Worker(buildDeps(pool, cfg, log));
await worker.start();

let stopping = false;
const shutdown = async (sig: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, "shutting down");
  await worker.stop().catch((e: unknown) => log.error({ err: String(e) }, "shutdown"));
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
