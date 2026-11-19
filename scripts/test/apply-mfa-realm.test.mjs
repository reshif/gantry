// apply-mfa-realm.mjs against a recording mock of Keycloak's admin API: the mail server and a test mail come before any flow change (G-M3), a dry run works
// on a realm that lacks UPDATE_PASSWORD, and a half-built flow from an interrupted run is removed first (G-M7).
// Run: node --test "scripts/test/*.test.mjs"
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "deploy/keycloak/apply-mfa-realm.mjs");

async function mock({ mailFails = false, leftover = false } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const key = `${req.method} ${u.pathname}`;
      calls.push(key);
      const json = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(v === undefined ? "" : JSON.stringify(v)); };
      if (u.pathname.endsWith("/openid-connect/token")) return json(200, { access_token: "t" });
      if (key === "GET /admin/realms/gantry") return json(200, { realm: "gantry", browserFlow: "gantry-browser" });
      if (key === "PUT /admin/realms/gantry") return json(204);
      if (key === "GET /admin/realms/gantry/authentication/flows") return json(200, leftover ? [{ id: "f1", alias: "gantry-browser~new" }, { id: "f2", alias: "gantry-browser" }] : [{ id: "f2", alias: "gantry-browser" }]);
      if (key === "DELETE /admin/realms/gantry/authentication/flows/f1") return json(204);
      if (key === "GET /admin/realms/gantry/authentication/required-actions") return json(200, [{ alias: "CONFIGURE_TOTP" }]); // no UPDATE_PASSWORD, like the old realms
      if (/^GET \/admin\/realms\/gantry\/authentication\/required-actions\/(CONFIGURE_TOTP|delete_account)$/.test(key)) return json(200, { alias: "CONFIGURE_TOTP" });
      if (key === "GET /admin/realms/gantry/authentication/unregistered-required-actions") return json(200, ["UPDATE_PASSWORD", "webauthn-register", "CONFIGURE_RECOVERY_AUTHN_CODES", "VERIFY_EMAIL"].map((p) => ({ providerId: p, name: p })));
      if (key === "POST /admin/realms/gantry/users") { res.writeHead(201, { location: `http://x/admin/realms/gantry/users/u1` }); return res.end(); }
      if (u.pathname.endsWith("/execute-actions-email")) return mailFails ? json(500, { errorMessage: "Invalid sender address" }) : json(204);
      if (req.method === "DELETE" && u.pathname.endsWith("/users/u1")) return json(204);
      if (key === "GET /admin/realms/gantry/clients") return json(200, []);
      return json(404, { error: "no mock" });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// async: the mock server lives in this process, so a blocking spawn would starve it
const exec = (args, env = { PATH: process.env.PATH }) => new Promise((res) => execFile(process.execPath, args, { encoding: "utf8", env }, (err, stdout, stderr) => res({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })));

function run(url, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "apply-mfa-"));
  writeFileSync(join(dir, "m"), "master-secret\n");
  writeFileSync(join(dir, "a"), "admin-client-secret\n");
  return exec([SCRIPT, "--url", url, "--realm", "gantry", "--master-password-file", join(dir, "m"), "--admin-secret-file", join(dir, "a"), "--realm-json", join(ROOT, "deploy/keycloak/realm-gantry.json"), ...extra]);
}

test("G-M3: a failed test mail stops the run before any flow, client or required-action change", async () => {
  const m = await mock({ mailFails: true });
  const r = await run(m.url, ["--smtp-test-to", "ops@example.test"]);
  m.close();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /STOPPED before any flow change/);
  assert.ok(!m.calls.some((c) => /authentication\/flows$/.test(c) && c.startsWith("POST")), "no flow was created");
  assert.ok(!m.calls.some((c) => c.includes("required-actions") && c.startsWith("PUT")), "no required action changed");
  assert.ok(!(r.stdout + r.stderr).includes("master-secret") && !(r.stdout + r.stderr).includes("admin-client-secret"), "no secret is printed");
});

test("G-M3: --smtp-test-to is required for a real run", async () => {
  const m = await mock();
  const r = await run(m.url);
  m.close();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--smtp-test-to/);
  assert.equal(m.calls.length, 0, "nothing was called");
});

test("G-M3: a production realm's mail settings come from GANTRY_SMTP_* in the environment; an unset one refuses before any change", async () => {
  const m = await mock();
  const dir = mkdtempSync(join(tmpdir(), "apply-mfa-"));
  writeFileSync(join(dir, "m"), "x"); writeFileSync(join(dir, "a"), "y");
  const r = await exec([SCRIPT, "--url", m.url, "--master-password-file", join(dir, "m"), "--admin-secret-file", join(dir, "a"), "--realm-json", join(ROOT, "deploy/keycloak/realm-gantry.prod.json"), "--public-url", "https://g.example", "--smtp-test-to", "ops@example.test"]);
  m.close();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /GANTRY_SMTP_HOST/);
  assert.ok(!m.calls.some((c) => c.startsWith("PUT") || c.startsWith("POST /admin")), "the realm was not touched");
});

test("G-M7: --dry-run works on a realm without UPDATE_PASSWORD and changes nothing", async () => {
  const m = await mock();
  const r = await run(m.url, ["--dry-run"]);
  m.close();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /UPDATE_PASSWORD: would be registered/);
  assert.ok(!m.calls.some((c) => c.startsWith("PUT") || (c.startsWith("POST") && !c.includes("openid-connect")) || c.startsWith("DELETE")), "a dry run writes nothing");
});

test("G-M7: a leftover gantry-browser~new flow from an interrupted run is removed first, not a 409", async () => {
  const m = await mock({ leftover: true });
  await run(m.url, ["--smtp-test-to", "ops@example.test"]);
  m.close();
  assert.ok(m.calls.includes("DELETE /admin/realms/gantry/authentication/flows/f1"));
  assert.ok(m.calls.indexOf("DELETE /admin/realms/gantry/authentication/flows/f1") < m.calls.findIndex((c) => c.endsWith("/execute-actions-email")), "cleaned before the mail test");
});
