#!/usr/bin/env node
// Writes realm-gantry.prod.json from realm-gantry.json: the same realm, client and user profile, without the demo
// accounts and their shared password (the scoped gantry-admin service account stays), with the public URL and the mail relay taken from the environment at import
// (Keycloak replaces ${VAR} and ${VAR:default} in an imported realm), and a password policy.
//
//   node deploy/keycloak/prod-realm.mjs           # rewrite the production realm
//   node deploy/keycloak/prod-realm.mjs --check   # exit 1 when it is out of date (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const dev = JSON.parse(readFileSync(here("./realm-gantry.json"), "utf8"));
const URL_ = "${GANTRY_PUBLIC_URL}";

const realm = { ...dev };
// No demo accounts and no shared demo password; the scoped service account (manage-users in this realm only, S-125) stays.
realm.users = dev.users.filter((u) => u.username.startsWith("service-account-"));
Object.assign(realm, {
  sslRequired: "all",
  registrationAllowed: false,
  bruteForceProtected: true,
  // IdP-side logins, failures, resets and admin edits (email and user changes drive Gantry identity linking) are recorded and kept 90 days.
  eventsEnabled: true,
  eventsExpiration: 7776000,
  eventsListeners: ["jboss-logging"],
  adminEventsEnabled: true,
  adminEventsDetailsEnabled: true,
  passwordPolicy: "length(12) and notUsername and notEmail and passwordHistory(5)",
  // Password reset and email verification mail. The relay is the same one Gantry uses.
  smtpServer: {
    host: "${GANTRY_SMTP_HOST}",
    port: "${GANTRY_SMTP_PORT:587}",
    from: "${GANTRY_SMTP_FROM_ADDRESS}",
    fromDisplayName: "Gantry",
    starttls: "${GANTRY_SMTP_STARTTLS:true}",
    ssl: "${GANTRY_SMTP_SSL:false}",
    auth: "${GANTRY_SMTP_AUTH:false}",
    user: "${GANTRY_SMTP_USER:}",
    password: "${GANTRY_SMTP_PASSWORD:}",
  },
});
const swap = (s) => (typeof s === "string" ? s.replaceAll("https://localhost", URL_) : s);
realm.clients = dev.clients.map((c) => ({
  ...c,
  rootUrl: swap(c.rootUrl),
  redirectUris: (c.redirectUris ?? []).map(swap),
  webOrigins: (c.webOrigins ?? []).map(swap),
  attributes: Object.fromEntries(Object.entries(c.attributes ?? {}).map(([k, v]) => [k, swap(v)])),
}));

const out = `${JSON.stringify(realm, null, 2)}\n`;
const target = here("./realm-gantry.prod.json");
if (process.argv.includes("--check")) {
  let cur = "";
  try { cur = readFileSync(target, "utf8"); } catch { /* missing */ }
  if (cur !== out) { console.error("deploy/keycloak/realm-gantry.prod.json is out of date: run node deploy/keycloak/prod-realm.mjs"); process.exit(1); }
  if (out.includes("gantry-dev") || out.includes("localhost")) { console.error("the production realm still mentions gantry-dev or localhost"); process.exit(1); }
  console.log("production realm up to date");
} else {
  writeFileSync(target, out);
  console.log(`wrote ${target}`);
}
