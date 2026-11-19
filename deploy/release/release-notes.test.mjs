import { test } from "node:test";
import assert from "node:assert/strict";
import { notes } from "./release-notes.mjs";

const manifest = (latest) => ({ migrations: { latest, lastContract: 0 }, images: { api: { digest: `sha256:${"a".repeat(64)}` } } });
const req = [{ id: "mfa-realm", fromMigration: 53, text: "apply the realm" }];

test("expand-only migrations say the rollback is automatic", () => {
  const t = notes({ manifest: manifest(53), newMigrations: [{ name: "0053_x.sql", contract: false }], previousLatest: 52, requires: [], tag: "v1.3.0" });
  assert.match(t, /Upgrading to v1.3.0/); assert.match(t, /rolls back by itself/); assert.doesNotMatch(t, /cannot be rolled back/);
});
test("a contract migration says there is no automatic rollback past it", () => {
  assert.match(notes({ manifest: manifest(54), newMigrations: [{ name: "0054_d.sql", contract: true }], previousLatest: 53, requires: [] }), /cannot be rolled back automatically/);
});
test("a person-only step is listed only for the release that first crosses it", () => {
  assert.match(notes({ manifest: manifest(53), newMigrations: [], previousLatest: 52, requires: req }), /mfa-realm/);
  assert.doesNotMatch(notes({ manifest: manifest(54), newMigrations: [], previousLatest: 53, requires: req }), /mfa-realm/);
});
