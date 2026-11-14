// Container healthcheck: the worker has no HTTP port, so it touches a file every 5 s; healthy while that file is fresh.
import { statSync } from "node:fs";

const file = process.env.WORKER_HEARTBEAT_FILE || "/tmp/worker-heartbeat";
try {
  process.exit(Date.now() - statSync(file).mtimeMs < 30_000 ? 0 : 1);
} catch {
  process.exit(1);
}
