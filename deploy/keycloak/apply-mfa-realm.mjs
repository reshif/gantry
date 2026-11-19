#!/usr/bin/env node
// One-off migration of an EXISTING Keycloak realm to the MFA-for-everyone configuration (MFA review S-122, S-124..S-128, S-126).
//
// Why a script: Keycloak's --import-realm skips a realm that already exists, so editing realm-gantry*.json changes only fresh installs. This
// applies the same configuration to a live realm through the admin REST API, without touching users, their credentials or their sessions:
//   - the browser flow: password, then a second factor the person ALREADY has (authenticator app, security key or recovery code). A person with none is
//     refused (no self-service enrolment from a password alone); the first authenticator comes only from a one-time link an administrator issues in Gantry.
//   - the required actions (UPDATE_PASSWORD, CONFIGURE_TOTP, WebAuthn, recovery codes) and the OTP / WebAuthn policy, admin links valid at most one hour.
//   - the `gantry-admin` service-account client (manage-users in this realm only) the API uses instead of the master-admin password, and the extra
//     redirect URI the enrolment link returns to.
// The new flows are built beside the old ones, the realm is switched, then the old ones are deleted and the new ones renamed, so the realm is never
// without a flow that requires a second factor (a person is refused for a moment rather than let in).
//
// ORDER (nothing here can leave the realm unable to send a link): 1 remove a leftover half-built flow from an interrupted run; 2 set the realm's mail server
// and send a TEST MAIL (the run stops here, flows untouched, if either fails: --smtp-test-to is required); 3 only then the OTP / WebAuthn policy, required actions,
// the new flows (beside the old), the switch, the clients and the service account. A prod realm's mail settings come from the realm JSON's ${GANTRY_SMTP_*}
// placeholders, read from THIS process's environment (export them first; nothing is printed); the dev realm's are mailpit.
//
//   node deploy/keycloak/apply-mfa-realm.mjs --url http://127.0.0.1:8081/idp --realm gantry \
//        --master-password-file <file with the Keycloak master admin password> --admin-secret-file <deploy/secrets/idp_admin_client_secret> \
//        --smtp-test-to <an address you read> \
//        [--realm-json deploy/keycloak/realm-gantry.prod.json --public-url https://your.site] [--master-user admin] [--dry-run]
//
// It reads the two files itself and never prints their contents. Run it once per realm; running it again is safe (it converges).
import { readFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(a.slice(2), true);
  else { args.set(a.slice(2), next); i++; }
}
const need = (k) => { const v = args.get(k); if (typeof v !== "string") { console.error(`missing --${k}`); process.exit(2); } return v; };
const base = need("url").replace(/\/+$/, "");
const realm = typeof args.get("realm") === "string" ? args.get("realm") : "gantry";
const dry = args.get("dry-run") === true;
const jsonPath = typeof args.get("realm-json") === "string" ? args.get("realm-json") : new URL("./realm-gantry.prod.json", import.meta.url).pathname;
const smtpTestTo = typeof args.get("smtp-test-to") === "string" ? args.get("smtp-test-to") : null;
if (!smtpTestTo && !dry) { console.error("--smtp-test-to <address> is required: a test mail must arrive before any flow is switched, or nobody could be given an enrolment link"); process.exit(2); }
const masterUser = typeof args.get("master-user") === "string" ? args.get("master-user") : "admin";
const masterPassword = readFileSync(need("master-password-file"), "utf8").replace(/\r?\n$/, "");
const adminSecret = readFileSync(need("admin-secret-file"), "utf8").replace(/\r?\n$/, "");
if (!masterPassword || !adminSecret) { console.error("a secret file is empty"); process.exit(2); }
const publicUrl = typeof args.get("public-url") === "string" ? args.get("public-url").replace(/\/+$/, "") : null;
let wantText = readFileSync(jsonPath, "utf8");
if (wantText.includes("${GANTRY_PUBLIC_URL}")) {
  if (!publicUrl) { console.error("the production realm names ${GANTRY_PUBLIC_URL}: pass --public-url https://your.site"); process.exit(2); }
  wantText = wantText.replaceAll("${GANTRY_PUBLIC_URL}", publicUrl);
}
const want = JSON.parse(wantText);

const tokenRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: masterUser, password: masterPassword }),
});
if (!tokenRes.ok) { console.error(`master admin sign-in failed (HTTP ${tokenRes.status})`); process.exit(1); }
const token = (await tokenRes.json()).access_token;

const api = async (method, path, body, ok = [200, 201, 204]) => {
  if (dry && method !== "GET") { console.log(`  [dry-run] ${method} ${path}`); return { status: 204, json: null, headers: new Headers() }; }
  const res = await fetch(`${base}/admin/realms/${encodeURIComponent(realm)}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, json: text && /^[[{]/.test(text) ? JSON.parse(text) : null, headers: res.headers };
};
const log = (m) => console.log(m);

/* ---- 1. a half-built flow left by an interrupted run */
const NEW = "~new";
{
  const left = ((await api("GET", "/authentication/flows")).json ?? []).filter((f) => f.alias.endsWith(NEW));
  for (const f of left) { log(`leftover flow ${f.alias} from an interrupted run: removing it`); await api("DELETE", `/authentication/flows/${f.id}`, undefined, [200, 204, 404]); }
}

/* ---- 2. the mail server, and a test mail, before anything else changes */
const resolveEnv = (v) => typeof v !== "string" ? v : v.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g, (_m, name, dflt) => process.env[name] ?? (dflt !== undefined ? dflt : `\u0000${name}`));
const smtp = Object.fromEntries(Object.entries(want.smtpServer ?? {}).map(([k, v]) => [k, resolveEnv(v)]));
const missing = Object.entries(smtp).filter(([, v]) => typeof v === "string" && v.includes("\u0000")).map(([k, v]) => String(v).replace(/[^A-Z0-9_]/g, ""));
if (!smtp.host || !smtp.from || missing.length) {
  console.error(`the realm JSON's mail server is incomplete (${missing.length ? `set ${[...new Set(missing)].join(", ")} in this shell` : "no host or from address"}); nothing was changed`);
  process.exit(1);
}
log(`mail server: ${smtp.host}:${smtp.port ?? "25"} from ${smtp.from} (values from the realm JSON and this environment; not printed beyond host and from)`);
const before = (await api("GET", "")).json;
await api("PUT", "", { ...before, smtpServer: smtp });
if (!dry) {
  const probe = `gantry-smtp-test-${Date.now()}`;
  const mk = await api("POST", "/users", { username: probe, email: smtpTestTo, enabled: true, emailVerified: false }, [201, 409]);
  const probeId = mk.headers.get("location")?.split("/").pop();
  let sent = false;
  try { await api("PUT", `/users/${probeId}/execute-actions-email?lifespan=300`, ["VERIFY_EMAIL"], [200, 204]); sent = true; } catch (e) { console.error(`the test mail could not be sent: ${String(e.message).replace(/\s+/g, " ").slice(0, 160)}`); }
  if (probeId) await api("DELETE", `/users/${probeId}`, undefined, [200, 204, 404]);
  if (!sent) { console.error("STOPPED before any flow change: fix the mail server (Realm settings > Email > Test connection) and run this again"); process.exit(1); }
  log(`test mail sent to ${smtpTestTo}: confirm it arrived before relying on enrolment links`);
} else log(`[dry-run] would send a test mail to ${smtpTestTo ?? "(address not given)"} and stop if it fails`);

/* ---- 3. realm settings */
const current = (await api("GET", "")).json;
const settings = {};
for (const k of ["otpPolicyType", "otpPolicyAlgorithm", "otpPolicyDigits", "otpPolicyPeriod", "otpPolicyLookAheadWindow", "otpPolicyCodeReusable", "webAuthnPolicyRpEntityName", "webAuthnPolicySignatureAlgorithms", "webAuthnPolicyUserVerificationRequirement", "webAuthnPolicyRequireResidentKey", "webAuthnPolicyAuthenticatorAttachment", "webAuthnPolicyAttestationConveyancePreference", "webAuthnPolicyCreateTimeout", "webAuthnPolicyAvoidSameAuthenticatorRegister", "actionTokenGeneratedByAdminLifespan", "resetPasswordAllowed", "adminEventsEnabled", "adminEventsDetailsEnabled"]) if (want[k] !== undefined) settings[k] = want[k];
log("realm: OTP and WebAuthn policy, admin link lifespan, admin events on");
await api("PUT", "", { ...current, ...settings });

/* ---- required actions */
log("required actions");
const have = (await api("GET", "/authentication/required-actions")).json;
const unregistered = (await api("GET", "/authentication/unregistered-required-actions")).json;
for (const a of want.requiredActions ?? []) {
  if (!have.some((h) => h.alias === a.alias)) {
    const u = unregistered.find((x) => x.providerId === a.providerId);
    if (!u) { log(`  skip ${a.alias}: this Keycloak has no such action`); continue; }
    await api("POST", "/authentication/register-required-action", { providerId: u.providerId, name: u.name });
  }
  if (dry && !have.some((h) => h.alias === a.alias)) { log(`  ${a.alias}: would be registered and ${a.enabled ? "enabled" : "disabled"}`); continue; }
  const cur = (await api("GET", `/authentication/required-actions/${encodeURIComponent(a.alias)}`)).json;
  await api("PUT", `/authentication/required-actions/${encodeURIComponent(a.alias)}`, { ...cur, enabled: a.enabled, defaultAction: a.defaultAction, priority: a.priority });
  log(`  ${a.alias}: ${a.enabled ? "enabled" : "disabled"}`);
}

/* ---- flows */
log("browser flow");
const flowsByAlias = new Map((want.authenticationFlows ?? []).map((f) => [f.alias, f]));
const top = want.browserFlow;
const fin = (alias) => alias; // final alias
const created = [];
async function buildFlow(alias, parentAlias, isTop) {
  const f = flowsByAlias.get(alias);
  const tmp = alias + NEW;
  if (isTop) await api("POST", "/authentication/flows", { alias: tmp, description: f.description, providerId: "basic-flow", topLevel: true, builtIn: false });
  created.push(tmp);
  for (const e of [...f.authenticationExecutions].sort((a, b) => a.priority - b.priority)) {
    let execId = null;
    if (e.authenticatorFlow) {
      const sub = flowsByAlias.get(e.flowAlias);
      const r = await api("POST", `/authentication/flows/${encodeURIComponent(tmp)}/executions/flow`, { alias: e.flowAlias + NEW, description: sub.description, provider: "registration-page-form", type: "basic-flow" });
      execId = r.json?.id ?? null;
      if (!dry) await buildFlow(e.flowAlias, tmp, false);
      else await buildFlow(e.flowAlias, tmp, false);
    } else {
      await api("POST", `/authentication/flows/${encodeURIComponent(tmp)}/executions/execution`, { provider: e.authenticator });
    }
    if (dry) continue;
    const list = (await api("GET", `/authentication/flows/${encodeURIComponent(tmp)}/executions`)).json;
    const row = e.authenticatorFlow ? list.find((x) => x.displayName === e.flowAlias + NEW || x.alias === e.flowAlias + NEW) : list.filter((x) => x.providerId === e.authenticator && x.level === 0).pop();
    if (!row) throw new Error(`could not find the execution just created in ${tmp}`);
    await api("PUT", `/authentication/flows/${encodeURIComponent(tmp)}/executions`, { ...row, requirement: e.requirement });
    if (e.authenticatorConfig) {
      const c = (want.authenticatorConfig ?? []).find((x) => x.alias === e.authenticatorConfig);
      await api("POST", `/authentication/executions/${row.id}/config`, { alias: `${e.authenticatorConfig}${NEW}`, config: c.config });
    }
  }
}
await buildFlow(top, null, true);
const listFlows = async () => (await api("GET", "/authentication/flows")).json ?? [];
if (!dry) {
  const cur2 = (await api("GET", "")).json;
  await api("PUT", "", { ...cur2, browserFlow: top + NEW });
  log("  realm now uses the new flow; removing the old gantry flows");
  for (const name of [top, ...flowsByAlias.keys()]) {
    const old = (await listFlows()).find((f) => f.alias === name && !f.builtIn);
    if (old) await api("DELETE", `/authentication/flows/${old.id}`, undefined, [200, 204, 404]);
  }
  // Rename what was built beside the old flows: authenticator configs, sub-flows (found from the tree), then the top flow.
  const rows = (await api("GET", `/authentication/flows/${encodeURIComponent(top + NEW)}/executions`)).json ?? [];
  for (const x of rows) {
    if (x.authenticationConfig) {
      const cfg = (await api("GET", `/authentication/config/${x.authenticationConfig}`)).json;
      if (cfg.alias.endsWith(NEW)) await api("PUT", `/authentication/config/${x.authenticationConfig}`, { ...cfg, alias: cfg.alias.slice(0, -NEW.length) });
    }
    if (x.authenticationFlow && x.flowId) {
      const sub = (await api("GET", `/authentication/flows/${x.flowId}`)).json;
      if (sub.alias.endsWith(NEW)) await api("PUT", `/authentication/flows/${x.flowId}`, { ...sub, alias: sub.alias.slice(0, -NEW.length) });
    }
  }
  const topNew = (await listFlows()).find((f) => f.alias === top + NEW);
  await api("PUT", `/authentication/flows/${topNew.id}`, { ...topNew, alias: top });
  const cur3 = (await api("GET", "")).json;
  await api("PUT", "", { ...cur3, browserFlow: top });
  log(`  browser flow is ${top}`);
}

/* ---- clients */
log("clients");
const clients = (await api("GET", "/clients")).json ?? [];
const web = clients.find((c) => c.clientId === "gantry-web");
const wantWeb = want.clients.find((c) => c.clientId === "gantry-web");
if (web && wantWeb) {
  const uris = [...new Set([...(web.redirectUris ?? []), ...wantWeb.redirectUris])];
  if (uris.length !== (web.redirectUris ?? []).length) { await api("PUT", `/clients/${web.id}`, { ...web, redirectUris: uris }); log("  gantry-web: added the enrolment-link return address"); }
}
const cli = clients.find((c) => c.clientId === "admin-cli");
if (cli && cli.directAccessGrantsEnabled) { await api("PUT", `/clients/${cli.id}`, { ...cli, directAccessGrantsEnabled: false }); log("  admin-cli: password-only direct grants turned off in this realm"); }
let svc = clients.find((c) => c.clientId === "gantry-admin");
const wantSvc = want.clients.find((c) => c.clientId === "gantry-admin");
if (!svc) {
  await api("POST", "/clients", { ...wantSvc, secret: adminSecret });
  svc = ((await api("GET", "/clients")).json ?? []).find((c) => c.clientId === "gantry-admin");
  log("  gantry-admin: created");
} else log("  gantry-admin: exists (its secret is left as it is; it must match the idp_admin_client_secret file)");
if (svc || dry) {
  const rm = ((await api("GET", "/clients")).json ?? []).find((c) => c.clientId === "realm-management");
  if (svc && rm) {
    const su = (await api("GET", `/clients/${svc.id}/service-account-user`)).json;
    const held = (await api("GET", `/users/${su.id}/role-mappings/clients/${rm.id}`)).json ?? [];
    for (const name of ["manage-users", "view-events"]) {
      if (held.some((r) => r.name === name)) continue;
      const role = (await api("GET", `/clients/${rm.id}/roles/${name}`)).json;
      await api("POST", `/users/${su.id}/role-mappings/clients/${rm.id}`, [role]);
    }
    log(`  gantry-admin service account: manage-users and view-events in ${realm} only (${held.filter((r) => !["manage-users", "view-events"].includes(r.name)).length} other roles held)`);
  }
}
log(dry ? "dry run done: nothing was changed" : "done. Every person without a second factor is now refused at sign-in until an administrator sends them an enrolment link.");
