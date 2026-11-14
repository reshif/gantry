import { ApiClient } from "./api.js";
import { loadConfig } from "./config.js";
import { buildGateway } from "./gateway.js";
import { buildProxy } from "./proxy.js";
import { NoObjectStore, S3ObjectStore } from "./trace.js";

const cfg = await loadConfig();
const api = new ApiClient(cfg);
const store = cfg.s3 ? new S3ObjectStore(cfg.s3) : new NoObjectStore();
const gw = buildGateway({ cfg, api, store });
if (!cfg.s3) gw.app.log.warn("no object storage configured: traces are dropped and checkpoints are refused");
const proxy = buildProxy({ cfg, api, logger: gw.app.log });

await gw.app.listen({ host: "0.0.0.0", port: cfg.modelPort });
await new Promise<void>((resolve) => proxy.server.listen(cfg.proxyPort, "0.0.0.0", resolve));
gw.app.log.info({ model: cfg.modelPort, proxy: cfg.proxyPort }, "gantry-edge listening");

const stop = (): void => {
  proxy.server.close();
  void gw.drain().then(() => gw.app.close()).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
