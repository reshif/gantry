// The dev Keycloak realm comes in two copies: realm-gantry.json (with the seeded demo users) and realm-gantry.empty.json
// (the same realm without them). Compose imports the first only when GANTRY_DEV_SEED=true. Both carry the scoped gantry-admin service-account user.
// The MFA review (S-120..S-130) also pins what the realm and the compose files say about the second factor.
// Run: node --test "scripts/test/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("the empty realm is the seeded realm without its users, so the two never drift", () => {
  const full = JSON.parse(read("deploy/keycloak/realm-gantry.json"));
  const empty = JSON.parse(read("deploy/keycloak/realm-gantry.empty.json"));
  assert.ok(Array.isArray(full.users) && full.users.length > 0, "the seeded realm has demo users");
  assert.ok(!empty.users.some((u) => !u.username.startsWith("service-account-")), "the empty realm has no demo users");
  const { users: _users, ...rest } = full;
  const { users: emptyUsers, ...emptyRest } = empty;
  assert.deepEqual(emptyRest, rest);
  assert.deepEqual(emptyUsers.map((u) => u.username), ["service-account-gantry-admin"], "the empty realm keeps only the service account");
});

test("compose imports the demo users only when GANTRY_DEV_SEED=true", () => {
  const compose = read("deploy/compose.yml");
  assert.ok(compose.includes('if [ "$${GANTRY_DEV_SEED:-false}" = "true" ]; then src=realm-gantry.json; else src=realm-gantry.empty.json; fi'));
  assert.ok(compose.includes("./keycloak/realm-gantry.empty.json:/opt/keycloak/realms/realm-gantry.empty.json:ro"));
  assert.ok(!compose.includes("realm-gantry.json:/opt/keycloak/data/import/realm-gantry.json"), "no direct mount into the import dir");
  assert.ok(compose.includes("GANTRY_DEV_SEED: ${GANTRY_DEV_SEED:-false}"));
});

const flowOf = (realm, alias) => realm.authenticationFlows.find((f) => f.alias === alias);
const execs = (realm, alias) => flowOf(realm, alias).authenticationExecutions;
const realms = () => ({ dev: JSON.parse(read("deploy/keycloak/realm-gantry.json")), prod: JSON.parse(read("deploy/keycloak/realm-gantry.prod.json")) });

test("S-122: a password alone never enrols an authenticator: no required OTP step, enrolment only by an admin link, a person with no factor is refused", () => {
  for (const [name, r] of Object.entries(realms())) {
    assert.equal(r.browserFlow, "gantry-browser", name);
    const all = r.authenticationFlows.flatMap((f) => f.authenticationExecutions);
    // an OTP form that is REQUIRED sends a user who has none to CONFIGURE_TOTP, which a password alone satisfies
    assert.ok(!all.some((e) => e.authenticator === "auth-otp-form" && e.requirement === "REQUIRED"), `${name}: no REQUIRED OTP form`);
    assert.ok(!all.some((e) => e.authenticator === "webauthn-authenticator" && e.requirement === "REQUIRED"), `${name}: no REQUIRED WebAuthn`);
    const second = execs(r, "gantry-second-factor");
    assert.equal(second[0].authenticator, "conditional-user-configured");
    assert.deepEqual(second.slice(1).map((e) => [e.authenticator, e.requirement]), [["auth-otp-form", "ALTERNATIVE"], ["webauthn-authenticator", "ALTERNATIVE"], ["auth-recovery-authn-code-form", "ALTERNATIVE"]]);
    const deny = execs(r, "gantry-no-factor");
    assert.deepEqual(deny.map((e) => e.authenticator), ["conditional-sub-flow-executed", "deny-access-authenticator"]);
    const cond = r.authenticatorConfig.find((c) => c.alias === deny[0].authenticatorConfig).config;
    assert.deepEqual(cond, { flow_to_check: "gantry-second-factor", check_result: "not-executed" });
    // password first, then the second factor, then the level: every sign-in is two-step, whatever acr_values the client sent
    assert.deepEqual(execs(r, "gantry-browser-forms").map((e) => e.authenticator ?? e.flowAlias), ["auth-username-password-form", "gantry-second-factor", "gantry-no-factor", "gantry-level-2"]);
    assert.equal(r.resetPasswordAllowed, false, `${name}: no self-service password reset (it could re-enrol)`);
    assert.equal(r.otpPolicyCodeReusable, false);
    assert.ok(r.actionTokenGeneratedByAdminLifespan <= 3600, `${name}: an admin-issued link lives at most an hour`);
  }
});

test("S-126 and S-128: UPDATE_PASSWORD is a registered required action; WebAuthn and recovery codes are enabled next to TOTP", () => {
  for (const [name, r] of Object.entries(realms())) {
    const on = new Map(r.requiredActions.map((a) => [a.alias, a.enabled]));
    for (const a of ["UPDATE_PASSWORD", "CONFIGURE_TOTP", "webauthn-register", "CONFIGURE_RECOVERY_AUTHN_CODES"]) assert.equal(on.get(a), true, `${name}: ${a}`);
    assert.ok(r.requiredActions.find((a) => a.alias === "UPDATE_PASSWORD").priority < r.requiredActions.find((a) => a.alias === "CONFIGURE_TOTP").priority, "the password is changed before the authenticator is enrolled");
    assert.equal(r.webAuthnPolicyRpEntityName, "Gantry");
  }
});

test("S-125: the API's identity-provider account is a service account that can manage users in this realm and nothing else", () => {
  for (const [name, r] of Object.entries(realms())) {
    const c = r.clients.find((x) => x.clientId === "gantry-admin");
    assert.ok(c, name);
    assert.equal(c.serviceAccountsEnabled, true);
    assert.equal(c.standardFlowEnabled, false);
    assert.equal(c.directAccessGrantsEnabled, false);
    assert.equal(c.secret, "${GANTRY_ADMIN_CLIENT_SECRET}", "the secret is read from a file at import, never written in the realm");
    const u = r.users.find((x) => x.serviceAccountClientId === "gantry-admin");
    assert.deepEqual(u.clientRoles, { "realm-management": ["manage-users", "view-events"] }, "manage-users to act, view-events to read the admin events the watcher compares (G-M1)");
    assert.equal(r.adminEventsEnabled, true, `${name}: admin events are recorded`);
    assert.equal(r.adminEventsDetailsEnabled, true);
    assert.equal(u.realmRoles, undefined);
  }
});

test("S-120: compose does not waive the second factor by default; production forces it off; the flag is only a dev opt-in", () => {
  assert.ok(read("deploy/compose.yml").includes("GANTRY_DEV_ADMIN_MFA_OPTIONAL: ${GANTRY_DEV_ADMIN_MFA_OPTIONAL:-false}"));
  assert.ok(read("deploy/compose.prod.yml").includes('GANTRY_DEV_ADMIN_MFA_OPTIONAL: "false"'));
  for (const f of ["README.md", "deploy/PRODUCTION.md"]) {
    const doc = read(f);
    assert.match(doc, /MFA is required for everyone/i, `${f} says MFA is required for everyone`);
    assert.ok(!/GANTRY_DEV_ADMIN_MFA_OPTIONAL[^\n]*default[^\n]*\btrue\b/i.test(doc) && !/waived by default/i.test(doc), `${f} must not say the waiver is on by default`);
  }
});

test("S-125: the API container never gets the Keycloak master-admin password; the service-account secret is wired to it and to Keycloak", () => {
  for (const f of ["deploy/compose.yml", "deploy/compose.prod.yml"]) {
    const c = read(f);
    for (const m of c.matchAll(/^  (gantry-api|gantry-worker|gantry-migrate):[\s\S]*?^(?=  \S)/gm)) assert.ok(!m[0].includes("keycloak_admin_password"), `${f}: ${m[1]} must not mount it`);
  }
  const dev = read("deploy/compose.yml");
  assert.match(dev, /gantry-api:[\s\S]*?secrets: \[[^\]]*idp_admin_client_secret/);
  assert.match(dev, /keycloak:[\s\S]*?secrets: \[[^\]]*idp_admin_client_secret/);
  assert.ok(dev.includes("GANTRY_ADMIN_CLIENT_SECRET"));
  assert.ok(read("deploy/compose.prod.yml").includes("GANTRY_ADMIN_CLIENT_SECRET"));
});

test("G-M8: admin-cli takes no password-only direct grant in this realm", () => {
  for (const [name, r] of Object.entries(realms())) {
    const c = r.clients.find((x) => x.clientId === "admin-cli");
    assert.ok(c, `${name}: admin-cli is defined`);
    assert.equal(c.directAccessGrantsEnabled, false);
  }
});
