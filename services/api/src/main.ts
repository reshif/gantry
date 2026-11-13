import { createPool } from "@gantry/db";
import { buildApp } from "./core/app.js";
import { bootstrapOrg } from "./core/bootstrap.js";
import { loadConfig } from "./core/config.js";

const config = await loadConfig();
const pool = createPool("app", { applicationName: "gantry-api", max: 20 });
const log = { info: (o: object, m?: string) => console.log(JSON.stringify({ level: "info", msg: m ?? "boot", ...o })) };
const { orgId } = await bootstrapOrg(pool, config, log);
const app = await buildApp({ pool, config, orgId });
await app.listen({ host: config.host, port: config.port });

const stop = async (): Promise<void> => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
