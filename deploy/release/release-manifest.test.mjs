import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGES, build, validate } from "./release-manifest.mjs";

const sha = "a".repeat(40);
const dg = (c) => `sha256:${c.repeat(64)}`;
const images = Object.fromEntries(IMAGES.map((n, i) => [n, dg(String(i))]));
const good = () => build({ sha, repository: "Acme/Gantry", runId: 7, images, migrations: { latest: 52, lastContract: 0, contracts: [] } });

test("a built manifest is valid and names images by digest under the owner's registry path", () => {
  const m = good();
  assert.deepEqual(validate(m, { sha }), []);
  assert.equal(m.images.api.ref, "ghcr.io/acme/gantry-api");
});
test("a missing image, a tag instead of a digest, another registry and a wrong sha are refused", () => {
  const m = good(); delete m.images.web;
  assert.match(validate(m).join(), /image web is missing/);
  const t = good(); t.images.api.digest = "latest";
  assert.match(validate(t).join(), /digest must be/);
  const r = good(); r.images.api.ref = "evil.example/acme/gantry-api";
  assert.match(validate(r).join(), /ref must be under/);
  assert.match(validate(good(), { sha: "b".repeat(40) }).join(), /expected/);
});
test("the contract level cannot exceed the latest migration", () => {
  const m = good(); m.migrations = { latest: 3, lastContract: 4, contracts: [] };
  assert.match(validate(m).join(), /lastContract/);
});
test("a contract must name its commit and match lastContract", () => {
  const m = good(); m.migrations = { latest: 55, lastContract: 55, contracts: [{ n: 55, after: "b".repeat(40) }] };
  assert.deepEqual(validate(m), []);
  m.migrations.contracts = [{ n: 55, after: "abc" }];
  assert.match(validate(m).join(), /40-hex/);
  m.migrations.contracts = [];
  assert.match(validate(m).join(), /highest contract/);
});
