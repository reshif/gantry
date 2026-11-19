// Dry-run tests of the host deploy script: its decisions (order, contract, preconditions, rollback) run for real on a scratch
// state directory and a scratch git history; docker, cosign and the network are never touched (DRY_RUN=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const have = (c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
const skip = !["jq", "git", "node", "flock"].every(have) && "jq, git and flock are required";

const dir = mkdtempSync(join(tmpdir(), "gantry-release-"));
const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
const shas = [];
for (const i of [1, 2, 3]) { writeFileSync(join(repo, "f"), String(i)); git("add", "f"); git("commit", "-q", "-m", `c${i}`); shas.push(git("rev-parse", "HEAD")); }
const [c1, c2, c3] = shas;

const manifest = (sha, latest, lastContract) => ({
  schema: 1, sha, repository: "acme/gantry", run: { id: "1" },
  images: Object.fromEntries(["api", "worker", "migrate", "launcher", "edge", "github", "web", "runner", "keycloak", "backup"].map((n) => [n, { ref: `ghcr.io/acme/gantry-${n}`, digest: `sha256:${"a".repeat(64)}` }])),
  migrations: { latest, lastContract },
});
const write = (name, m) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(m)); return p; };
const bundle = write("bundle.json", {});

let n = 0;
function host(state) { // a fresh state directory per test
  const sd = join(dir, `state${n++}`); mkdirSync(sd);
  writeFileSync(join(sd, "state.json"), JSON.stringify({ live: null, previous: null, highestStarted: null, applied: { latest: 0, lastContract: 0 }, lastBackup: null, acks: [], ...state }));
  return sd;
}
function sh(sd, ...args) {
  const r = spawnSync("bash", [join(here, "gantry-release.sh"), ...args], { encoding: "utf8", env: { ...process.env, DRY_RUN: "1", GANTRY_STATE_DIR: sd, GANTRY_REPOSITORY: "acme/gantry", GANTRY_REPO_DIR: repo, GANTRY_ENV_FILE: join(dir, "prod.env") } });
  return { code: r.status, out: r.stdout + r.stderr };
}
const live = (sha, latest = 0) => ({ sha, manifest: write(`m-${sha.slice(0, 6)}-${latest}.json`, manifest(sha, latest, 0)), migrations: { latest, lastContract: 0 } });

test("a newer commit deploys: backup, migrate, up, gate; the state records it", { skip }, () => {
  const sd = host({ live: live(c1, 1), highestStarted: c1, applied: { latest: 1, lastContract: 0 } });
  const r = sh(sd, "deploy", write("n.json", manifest(c2, 2, 0)), bundle);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /gantry-backup.sh now/);
  const st = JSON.parse(execFileSync("cat", [join(sd, "state.json")], { encoding: "utf8" }));
  assert.equal(st.live.sha, c2); assert.equal(st.previous.sha, c1); assert.equal(st.applied.latest, 2); assert.equal(st.highestStarted, c2);
});
test("an older commit is refused after a newer one started, and nothing changes", { skip }, () => {
  const sd = host({ live: live(c3, 2), highestStarted: c3, applied: { latest: 2, lastContract: 0 } });
  const r = sh(sd, "deploy", write("o.json", manifest(c2, 2, 0)), bundle);
  assert.equal(r.code, 30); assert.match(r.out, /superseded/);
  assert.doesNotMatch(r.out, /backup/);
});
test("the commit that is live, or that already started and rolled back, is not deployed again", { skip }, () => {
  assert.match(sh(host({ live: live(c2, 2), highestStarted: c2 }), "deploy", write("l.json", manifest(c2, 2, 0)), bundle).out, /already live/);
  assert.match(sh(host({ live: live(c1, 1), highestStarted: c2 }), "deploy", write("l2.json", manifest(c2, 2, 0)), bundle).out, /fix forward/);
});
test("a contract migration needs the running release to be one step behind it, else it is refused", { skip }, () => {
  const refused = sh(host({ live: live(c1, 1), highestStarted: c1, applied: { latest: 1, lastContract: 0 } }), "deploy", write("c1.json", manifest(c3, 5, 5)), bundle);
  assert.equal(refused.code, 30); assert.match(refused.out, /stops using it first/);
  const ok = sh(host({ live: live(c1, 4), highestStarted: c1, applied: { latest: 4, lastContract: 0 } }), "deploy", write("c2.json", manifest(c3, 5, 5)), bundle);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /no automatic rollback past it/);
});
test("a step only a person can do blocks the release until it is acknowledged on the host", { skip }, () => {
  const sd = host({ live: live(c1, 52), highestStarted: c1, applied: { latest: 52, lastContract: 0 } });
  const m = write("p.json", manifest(c2, 53, 0));
  const blocked = sh(sd, "deploy", m, bundle);
  assert.equal(blocked.code, 30); assert.match(blocked.out, /mfa-realm/); assert.doesNotMatch(blocked.out, /backup/);
  assert.equal(sh(sd, "ack", "mfa-realm").code, 0);
  const after = sh(sd, "deploy", m, bundle); assert.equal(after.code, 0, after.out);
});
test("rollback goes to the previous release when no contract migration is applied", { skip }, () => {
  const sd = host({ live: live(c2, 2), previous: live(c1, 1), applied: { latest: 2, lastContract: 0 } });
  const r = sh(sd, "rollback");
  assert.equal(r.code, 10, r.out); assert.match(r.out, /up -d --no-deps/); assert.doesNotMatch(r.out, /--no-deps[^\n]*gantry-migrate/);
});
test("rollback past an applied contract migration is refused and a person is needed", { skip }, () => {
  const r = sh(host({ live: live(c2, 5), previous: live(c1, 4), applied: { latest: 5, lastContract: 5 }, lastBackup: "20261119T020000Z" }), "rollback");
  assert.equal(r.code, 20); assert.match(r.out, /cannot roll back/); assert.match(r.out, /20261119T020000Z/);
});
test("rollback with no previous release needs a person", { skip }, () => {
  assert.equal(sh(host({ live: live(c1, 1) }), "rollback").code, 20);
});
test("two deploys cannot hold the lock together", { skip: skip || !have("flock") }, () => {
  const sd = host({});
  const r = spawnSync("bash", ["-c", `exec 8>"${join(sd, "lock")}"; flock -n 8; bash "${join(here, "gantry-release.sh")}" deploy "${write("k.json", manifest(c2, 2, 0))}" "${bundle}"`], { encoding: "utf8", env: { ...process.env, DRY_RUN: "1", GANTRY_STATE_DIR: sd, GANTRY_REPOSITORY: "acme/gantry", GANTRY_REPO_DIR: repo, GANTRY_ENV_FILE: join(dir, "prod.env") } });
  assert.equal(r.status, 75); assert.match(r.stdout + r.stderr, /another deploy holds the lock/);
});
