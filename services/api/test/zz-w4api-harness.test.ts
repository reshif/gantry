// TEMPORARY live harness (removed at the end): the real API and the real worker on a throwaway database, for Playwright and curl.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import pino from "pino";
import { encrypt } from "@gantry/db";
import { it } from "vitest";
import { SESSION_KEY, TEST_URL, startApp } from "./helpers.js";
import { createSession } from "../src/core/auth/sessions.js";
import { ensureBuiltinTypes } from "../src/areas/integrations/store.js";
import { buildDeps, Worker } from "../../worker/src/worker.js";
import { testWorkerConfig } from "../../worker/test/world.js";

it.skipIf(!TEST_URL)("live", async () => {
  const dataKey = randomBytes(32);
  const t = await startApp({ config: { cookieSecure: false, sessionCookie: "gantry_session", publicUrl: "http://localhost:5199", secrets: { sessionKey: SESSION_KEY, dataKey, edgeToken: "edge-token-for-tests", githubToken: "github-token-for-tests" } } });
  await ensureBuiltinTypes(t.db.admin, t.orgId);
  const whsec = "whsec-" + randomBytes(12).toString("hex");
  await t.db.admin.query(
    `insert into integration_instances (org_id, id, type_id, name, enabled, config, secret_enc, secret_mask) values ($1,'gh-1','github','Acme GitHub',true,'{"org":"acme"}',$2,'whsec-••••')`,
    [t.orgId, encrypt(JSON.stringify({ webhookSecret: whsec }), dataKey, "integration:gh-1")],
  );
  await t.db.admin.query(`update people set github_login = 'tomas-acme' where id = 'p-tomas'`);
  await t.db.admin.query(`update repos set github_full_name = 'acme/' || name where false`);
  const deps = buildDeps(t.db.app, testWorkerConfig({ pollMs: 200 }), pino({ level: "warn" }));
  const worker = new Worker(deps);
  worker.start();
  await t.app.listen({ port: 18193, host: "127.0.0.1" });
  const s = await createSession(t.db.app, SESSION_KEY, { orgId: t.orgId, personId: "p-asha", method: "sso", ip: "127.0.0.1", userAgent: "pw", absoluteHours: 12, authTime: new Date(Date.now() + 3 * 3600_000) });
  const s2 = await createSession(t.db.app, SESSION_KEY, { orgId: t.orgId, personId: "p-tomas", method: "sso", ip: "127.0.0.1", userAgent: "pw", absoluteHours: 12, authTime: new Date() });
  writeFileSync("/tmp/claude-0/w4api-live.json", JSON.stringify({ cookieName: t.config.sessionCookie, asha: s.token, tomas: s2.token, whsec, org: t.orgId }));
  // eslint-disable-next-line no-console
  console.log("LIVE READY");
  await new Promise((r) => setTimeout(r, 55 * 60_000));
  await worker.stop(1000);
  await t.close();
}, 60 * 60_000);
