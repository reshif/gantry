import { test } from "node:test";
import assert from "node:assert/strict";
import { namesRepo } from "./provenance-names-repo.mjs";

const v1 = (repository, deps = []) => ({ "linux/amd64": { SLSA: { buildDefinition: { externalParameters: { workflow: { repository } }, resolvedDependencies: deps.map((uri) => ({ uri })) } } } });
const v02 = (uri, materials = []) => ({ SLSA: { invocation: { configSource: { uri } }, materials: materials.map((u) => ({ uri: u })) } });

test("accepts the repository itself, as a plain URL, .git, or git+ with a ref", () => {
  assert.ok(namesRepo(v1("https://github.com/Acme/gantry"), "acme/gantry"));
  assert.ok(namesRepo(v1("https://github.com/acme/gantry.git"), "acme/gantry"));
  assert.ok(namesRepo(v02("git+https://github.com/acme/gantry@refs/heads/main"), "acme/gantry"));
  assert.ok(namesRepo(v1("x", ["git+https://github.com/acme/gantry@refs/tags/v1.0.0"]), "acme/gantry"));
});
test("refuses a longer repository name, another owner, or a mere mention", () => {
  assert.ok(!namesRepo(v1("https://github.com/acme/gantry-fork"), "acme/gantry"));
  assert.ok(!namesRepo(v1("https://github.com/acme/gantry/evil"), "acme/gantry"));
  assert.ok(!namesRepo(v1("https://github.com/evil/acme/gantry"), "acme/gantry"));
  assert.ok(!namesRepo(v1("https://evil.example/?u=https://github.com/acme/gantry"), "acme/gantry"));
  assert.ok(!namesRepo({ SLSA: { buildDefinition: { internalParameters: { note: "https://github.com/acme/gantry" }, externalParameters: {} } } }, "acme/gantry"));
});
test("refuses missing provenance and a mixed set where one platform names another repository", () => {
  assert.ok(!namesRepo({}, "acme/gantry"));
  assert.ok(!namesRepo(null, "acme/gantry"));
  const mixed = { ...v1("https://github.com/acme/gantry"), "linux/arm64": v1("https://github.com/evil/gantry")["linux/amd64"] };
  assert.ok(!namesRepo(mixed, "acme/gantry"));
});
test("a dot in the repository name does not match any character", () => {
  assert.ok(!namesRepo(v1("https://github.com/acme/gantryXio"), "acme/gantry.io"));
});
