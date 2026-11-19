// S-73 and S-74: the ingress is production-shaped by default. Text checks on deploy/caddy and deploy/compose.yml.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy");
const read = (f) => readFileSync(join(DEPLOY, f), "utf8");

test("S-74: the base compose file defaults the ingress to the prod profile, so /mail and /v3 are opt-in", () => {
  assert.match(read("compose.yml"), /GANTRY_INGRESS_PROFILE: \$\{GANTRY_INGRESS_PROFILE:-prod\}/);
  assert.doesNotMatch(read("compose.yml"), /GANTRY_INGRESS_PROFILE:-dev/);
  assert.match(read("caddy/Caddyfile"), /\{\$GANTRY_INGRESS_PROFILE:prod\}/);
  assert.equal(read("caddy/profiles/prod.caddy").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length, 0, "the prod profile defines no routes");
  assert.match(read("caddy/profiles/dev.caddy"), /\/mail\/\*/);
  assert.match(read("README.md"), /GANTRY_INGRESS_PROFILE=dev/);
});

test("S-73: HSTS includes subdomains, and Cache-Control is added only when the API sent none", () => {
  const c = read("caddy/Caddyfile");
  assert.match(c, /Strict-Transport-Security "max-age=63072000; includeSubDomains"/);
  const api = c.slice(c.indexOf("handle @api"), c.indexOf("handle @idp") > 0 ? c.indexOf("@idp path") : undefined);
  assert.ok(!/header Cache-Control "no-store"/.test(api), "a plain header would double the API's own Cache-Control");
  assert.match(c, /header \?Cache-Control "no-store"/);
});
