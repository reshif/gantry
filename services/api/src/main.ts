import { createPool } from "@gantry/db";
import { buildApp } from "./core/app.js";
import { bootstrapOrg } from "./core/bootstrap.js";
import { anchorKeyFor, startAnchoring } from "./core/audit-anchor.js";
import { wireBootstrapAdmin } from "./core/auth/bootstrap-admin.js";
import { loadConfig } from "./core/config.js";

const config = await loadConfig();
const pool = createPool("app", { applicationName: "gantry-api", max: 20 });
const log = { info: (o: object, m?: string) => console.log(JSON.stringify({ level: "info", msg: m ?? "boot", ...o })) };
const { orgId } = await bootstrapOrg(pool, config, log);
const warnLog = { ...log, warn: (o: object, m?: string) => console.log(JSON.stringify({ level: "warn", msg: m ?? "boot", ...o })) };
if (config.bootstrapAdminEmail) warnLog.warn({ setting: "GANTRY_BOOTSTRAP_ADMIN_EMAIL" }, "GANTRY_BOOTSTRAP_ADMIN_EMAIL is deprecated; use GANTRY_BOOTSTRAP_ADMIN_USERNAME with the bootstrap_admin_password secret (deploy/README.md)");
// In the background: it waits for the identity provider and must never stop the API from starting.
void wireBootstrapAdmin({ pool, orgId, config, log: warnLog });
const app = await buildApp({ pool, config, orgId });
startAnchoring(app, orgId, config.auditAnchorFile, anchorKeyFor(config.secrets.sessionKey));
await app.listen({ host: config.host, port: config.port });

const stop = async (): Promise<void> => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
