import { createPool } from "@gantry/db";
import { buildApp } from "./core/app.js";
import { bootstrapOrg } from "./core/bootstrap.js";
import { anchorKeyFor, startAnchoring } from "./core/audit-anchor.js";
import { wireBootstrapAdmin } from "./core/auth/bootstrap-admin.js";
import { wireIdpAdmin } from "./core/auth/idp-admin.js";
import { backfillMfa, startIdpWatch } from "./core/auth/idp-watch.js";
import { loadConfig } from "./core/config.js";

const config = await loadConfig();
const pool = createPool("app", { applicationName: "gantry-api", max: 20 });
const log = { info: (o: object, m?: string) => console.log(JSON.stringify({ level: "info", msg: m ?? "boot", ...o })) };
const { orgId } = await bootstrapOrg(pool, config, log);
const warnLog = { ...log, warn: (o: object, m?: string) => console.log(JSON.stringify({ level: "warn", msg: m ?? "boot", ...o })) };
// With the username, the address is where the one-time enrolment link goes; alone it is the deprecated way to name the first Factory Admin.
if (config.bootstrapAdminEmail && !config.bootstrapAdminUsername) warnLog.warn({ setting: "GANTRY_BOOTSTRAP_ADMIN_EMAIL" }, "GANTRY_BOOTSTRAP_ADMIN_EMAIL alone is deprecated; use GANTRY_BOOTSTRAP_ADMIN_USERNAME with the bootstrap_admin_password secret (deploy/README.md)");
// In the background: it waits for the identity provider and must never stop the API from starting.
// The identity provider's admin API is a scoped service account (manage-users in this realm); the master-admin password never reaches this process (S-125).
const idpAdmin = await wireIdpAdmin({ config, onCall: (method, path) => void pool.query(`insert into idp_admin_log (org_id, method, path) values ($1,$2,$3)`, [orgId, method, path]).then(() => undefined, () => undefined) }).catch(() => null);
if (!idpAdmin) warnLog.warn({ secret: "idp_admin_client_secret" }, "no identity-provider service-account secret: enrolment links, authenticator resets and the bootstrap admin are unavailable");
void wireBootstrapAdmin({ pool, orgId, config, log: warnLog, idp: idpAdmin });
const app = await buildApp({ pool, config, orgId, idpAdmin });
startAnchoring(app, orgId, config.auditAnchorFile, anchorKeyFor(config.secrets.sessionKey));
await app.listen({ host: config.host, port: config.port });
// Who holds which second factors, read once from the provider (so the People status is right before anyone signs in again), then the provider's admin events every minute.
if (idpAdmin) {
  void backfillMfa(app.gantry).catch(() => undefined);
  startIdpWatch(app.gantry);
}

const stop = async (): Promise<void> => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
