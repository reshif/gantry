import Docker from "dockerode";
import { ApiClient } from "./api.js";
import { loadConfig } from "./config.js";
import { GithubApp } from "./github.js";
import { WriteLimiter } from "./ratelimit.js";
import { buildServer } from "./server.js";
import { DockerWorkspaceStore } from "./workspace.js";

const cfg = await loadConfig();
const app = new GithubApp(cfg.app, new WriteLimiter(cfg.writesPerMinute, cfg.writeBurst));
const store = new DockerWorkspaceStore(new Docker({ socketPath: cfg.dockerSocket }), cfg.helperImage);
const { server, poller } = await buildServer({ cfg, app, api: new ApiClient(cfg), store });
await server.listen({ port: cfg.port, host: cfg.host });
poller.start();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { poller.stop(); void server.close().then(() => process.exit(0)); });
