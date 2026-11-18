// The dev Keycloak realm comes in two copies: realm-gantry.json (with the seeded demo users) and realm-gantry.empty.json
// (the same realm with no users). Compose imports the first only when GANTRY_DEV_SEED=true.
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
  assert.equal(empty.users, undefined, "the empty realm has no users");
  const { users: _users, ...rest } = full;
  assert.deepEqual(empty, rest);
});

test("compose imports the demo users only when GANTRY_DEV_SEED=true", () => {
  const compose = read("deploy/compose.yml");
  assert.ok(compose.includes('if [ "$${GANTRY_DEV_SEED:-false}" = "true" ]; then src=realm-gantry.json; else src=realm-gantry.empty.json; fi'));
  assert.ok(compose.includes("./keycloak/realm-gantry.empty.json:/opt/keycloak/realms/realm-gantry.empty.json:ro"));
  assert.ok(!compose.includes("realm-gantry.json:/opt/keycloak/data/import/realm-gantry.json"), "no direct mount into the import dir");
  assert.ok(compose.includes("GANTRY_DEV_SEED: ${GANTRY_DEV_SEED:-false}"));
});
