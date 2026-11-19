// Replay of gantry-release.sh, NOT dry: docker and cosign are stubs that log every call, the health gate is a stub that answers from a
// script, the repository and the state are scratch. It shows what the script really does when a step fails (set -e, order, contract
// code check, backup first), which the dry-run tests cannot. No network, no real docker, no secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const have = (c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
const skip = !["jq", "git", "node", "flock"].every(have) && "jq, git and flock are required";

const W = mkdtempSync(join(tmpdir(), "gantry-replay-"));
const inst = join(W, "inst/deploy/release"), bin = join(W, "bin"), R = join(W, "repo"), LOG = join(W, "log"), GATE = join(W, "gate");
mkdirSync(inst, { recursive: true }); mkdirSync(bin); mkdirSync(R);
cpSync(here, inst, { recursive: true });
cpSync(join(here, "../ci"), join(W, "inst/deploy/ci"), { recursive: true });
const exe = (p, body) => { writeFileSync(p, body); chmodSync(p, 0o755); };
exe(join(inst, "health-gate.sh"), '#!/bin/sh\nif [ -s "$GATE_SEQ_FILE" ]; then r=$(head -n1 "$GATE_SEQ_FILE"); sed -i 1d "$GATE_SEQ_FILE"; else r=0; fi\necho "[stub gate rc=$r]" >>"$LOG"; exit "$r"\n');
exe(join(bin, "docker"), `#!/bin/sh
echo "docker $*" >>"$LOG"
case "$*" in
  *"gantry-backup.sh now"*) exit "\${BACKUP_NOW_RC:-0}";;
  *"gantry-backup.sh list"*) echo "\${BACKUP_LIST-SET-NEW 2026}"; exit 0;;
  *"run --rm gantry-migrate"*) exit "\${MIGRATE_RC:-0}";;
  *"psql"*) echo "\${DB_LATEST-}"; exit 0;;
  *"config --services"*) printf 'gantry-api\\ngantry-migrate\\n'; exit 0;;
  *"config --format json"*) echo '{"networks":{}}'; exit 0;;
  *"network inspect"*) exit 1;;
  *" up -d"*) exit "\${UP_RC:-0}";;
  *"pull"*) exit "\${PULL_RC:-0}";;
esac
exit 0
`);
exe(join(bin, "cosign"), `#!/bin/sh
echo "cosign $*" >>"$LOG"
case "$1" in
  verify-blob) [ "\${BLOB_BAD:-0}" = 1 ] && exit 1; exit 0;;
  verify) case "$*" in *"\${IMG_BAD:-NONE}"*) exit 1;; esac; exit 0;;
esac
exit 0
`);

const g = (...a) => execFileSync("git", ["-C", R, "-c", "user.name=t", "-c", "user.email=t@e.x", ...a], { encoding: "utf8" }).trim();
g("init", "-q", "-b", "main");
const c = [];
for (const i of [1, 2, 3]) { writeFileSync(join(R, "f"), String(i)); g("add", "f"); g("commit", "-q", "-m", `c${i}`); c.push(g("rev-parse", "HEAD")); }
const [c1, c2, c3] = c;
mkdirSync(join(R, "deploy/secrets"), { recursive: true }); writeFileSync(join(R, "deploy/secrets/idp_admin_client_secret"), "x"); writeFileSync(join(R, "deploy/prod.env"), "");
const IM = ["api", "worker", "migrate", "launcher", "edge", "github", "web", "runner", "keycloak", "backup"];
let k = 0;
const mk = (sha, latest, contracts = []) => {
  const p = join(W, `m${k++}.json`);
  writeFileSync(p, JSON.stringify({ schema: 1, sha, repository: "acme/gantry", run: { id: "1" }, images: Object.fromEntries(IM.map((n) => [n, { ref: `ghcr.io/acme/gantry-${n}`, digest: `sha256:${"a".repeat(64)}` }])), migrations: { latest, lastContract: contracts.length ? Math.max(...contracts.map((x) => x.n)) : 0, contracts } }));
  return p;
};
const bundle = join(W, "bundle"); writeFileSync(bundle, "{}");
const live = (sha, latest) => ({ sha, manifest: mk(sha, latest), migrations: { latest, lastContract: 0, contracts: [] } });

let SD, n = 0;
const st = (o = {}) => { SD = join(W, `s${n++}`); mkdirSync(SD); writeFileSync(join(SD, "state.json"), JSON.stringify({ live: null, previous: null, highestStarted: null, applied: { latest: 0, lastContract: 0 }, lastBackup: null, acks: [], ...o })); };
const state = () => JSON.parse(readFileSync(join(SD, "state.json"), "utf8"));
function run(args, env = {}) {
  writeFileSync(LOG, "");
  const r = spawnSync("bash", [join(inst, "gantry-release.sh"), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG, GATE_SEQ_FILE: GATE, GANTRY_STATE_DIR: SD, GANTRY_REPOSITORY: "acme/gantry", GANTRY_REPO_DIR: R, GANTRY_ENV_FILE: join(R, "deploy/prod.env"), GANTRY_SOURCE_DIR: "", ...env } });
  const log = readFileSync(LOG, "utf8");
  const saw = (re) => (log.match(new RegExp(re, "g")) ?? []).length;
  return { rc: r.status, out: r.stdout + r.stderr, log, saw };
}
const gate = (...v) => writeFileSync(GATE, v.join("\n") + (v.length ? "\n" : ""));
const deploy = (m, env) => { gate(); return run(["deploy", m, bundle], env); };
const base = (o = {}) => st({ highestStarted: c1, live: live(c1, 1), applied: { latest: 1, lastContract: 0 }, ...o });
const T = (name, fn) => test(name, { skip }, fn);

T("1 happy path: backup, migrate, up, gate", () => { st(); const r = deploy(mk(c2, 2), {}); assert.equal(r.rc, 0, r.out); assert.equal(r.saw("gantry-backup.sh now"), 1); assert.equal(r.saw("run --rm gantry-migrate"), 1); assert.equal(state().lastBackup, "SET-NEW"); });
T("2 an unsigned manifest is refused before any docker call", () => { st(); const r = deploy(mk(c2, 2), { BLOB_BAD: "1" }); assert.equal(r.rc, 30); assert.equal(r.saw("^docker"), 0); });
T("3 an image with no signature is refused before any docker call", () => { st(); const r = deploy(mk(c2, 2), { IMG_BAD: "gantry-web@" }); assert.equal(r.rc, 30); assert.equal(r.saw("^docker"), 0); });
T("4 an older commit after a newer one started is refused, nothing changes", () => { st({ highestStarted: c3, live: live(c3, 2), applied: { latest: 2, lastContract: 0 } }); const r = deploy(mk(c2, 2), {}); assert.equal(r.rc, 30); assert.match(r.out, /superseded/); assert.equal(r.saw("gantry-backup\\.sh"), 0); });

// G-C3 (model ContractSkip): the contract names the commit that stopped using what it drops; the RUNNING code must contain it.
T("5a a contract whose `after` commit is not in the running release is refused (the superseded-commit skip)", () => {
  base(); const r = deploy(mk(c3, 5, [{ n: 5, after: c2 }]), {}); assert.equal(r.rc, 30, r.out); assert.match(r.out, /safe only once a release containing/); assert.equal(r.saw("gantry-backup\\.sh"), 0);
});
T("5b a contract passes when the running release contains its `after` commit", () => {
  base({ live: live(c2, 4), highestStarted: c2, applied: { latest: 4, lastContract: 0 } }); const r = deploy(mk(c3, 5, [{ n: 5, after: c1 }]), {}); assert.equal(r.rc, 0, r.out); assert.equal(state().applied.lastContract, 5);
});
T("5c a contract with no running release recorded needs a person", () => { st(); const r = deploy(mk(c2, 2, [{ n: 2, after: c1 }]), {}); assert.equal(r.rc, 30); assert.match(r.out, /no running release is recorded/); });

T("6 a person-only step (MFA realm) refuses the release until acknowledged, also past it and on a fresh host", () => {
  base({ live: live(c1, 52), applied: { latest: 52, lastContract: 0 } });
  const a = deploy(mk(c2, 53), {}); assert.equal(a.rc, 30); assert.match(a.out, /mfa-realm/); assert.equal(a.saw("gantry-backup\\.sh"), 0);
  assert.equal(run(["ack", "mfa-realm"]).rc, 0);
  assert.equal(deploy(mk(c2, 53), {}).rc, 0);
  base({ live: live(c1, 52), applied: { latest: 52, lastContract: 0 } }); assert.equal(deploy(mk(c2, 60), {}).rc, 30);
  st(); assert.equal(deploy(mk(c2, 53), {}).rc, 30);
});

// G-C1 (model BackupFirst): any failure stops the deploy; a migration never follows a failed backup.
T("7 a failed backup stops the deploy: no migrate, no up, lastBackup not taken from an older set", () => {
  base(); const r = deploy(mk(c2, 2), { BACKUP_NOW_RC: "1" });
  assert.notEqual(r.rc, 0); assert.equal(r.saw("run --rm gantry-migrate"), 0); assert.equal(r.saw(" up -d"), 0); assert.equal(state().lastBackup, null); assert.match(r.out, /the backup failed/);
});
T("7b a backup that exits 0 but lists no set stops the deploy", () => { base(); const r = deploy(mk(c2, 2), { BACKUP_LIST: "" }); assert.notEqual(r.rc, 0); assert.equal(r.saw("run --rm gantry-migrate"), 0); });
T("7c a stale lastBackup from an earlier run is cleared, not reused", () => { base({ lastBackup: "OLD-SET" }); const r = deploy(mk(c2, 2), { BACKUP_NOW_RC: "1" }); assert.equal(state().lastBackup, null); assert.equal(r.saw("run --rm gantry-migrate"), 0); });
T("8 a failed pull stops the deploy", () => { st(); const r = deploy(mk(c2, 2), { PULL_RC: "1" }); assert.notEqual(r.rc, 0); assert.equal(r.saw("run --rm gantry-migrate"), 0); assert.equal(r.saw(" up -d"), 0); assert.equal(r.saw("gantry-backup\\.sh"), 0); });
T("8b a failed fetch into the install checkout stops the deploy", () => { st(); const r = deploy(mk(c2, 2), { GANTRY_SOURCE_DIR: join(W, "does-not-exist") }); assert.notEqual(r.rc, 0); assert.equal(r.saw("gantry-backup\\.sh"), 0); });

// G-C7
T("9 a failed migrate records the schema it may have moved (worst case when the database cannot be read) and keeps the order", () => {
  base({ live: live(c2, 4), highestStarted: c2, applied: { latest: 4, lastContract: 0 } });
  const r = deploy(mk(c3, 5, [{ n: 5, after: c1 }]), { MIGRATE_RC: "1" });
  assert.equal(r.rc, 1); const s = state(); assert.equal(s.highestStarted, c3); assert.equal(s.applied.latest, 5); assert.equal(s.applied.lastContract, 5); assert.equal(r.saw(" up -d"), 0);
});
T("9b a failed migrate trusts the database when it can be read", () => {
  base({ live: live(c2, 4), highestStarted: c2, applied: { latest: 4, lastContract: 0 } });
  const r = deploy(mk(c3, 5, [{ n: 5, after: c1 }]), { MIGRATE_RC: "1", DB_LATEST: "4" }); assert.equal(r.rc, 1); assert.equal(state().applied.latest, 4); assert.equal(state().applied.lastContract, 0);
});
T("10 unhealthy with an expand-only release rolls back to the previous release", () => { base(); gate(1, 0); const r = run(["deploy", mk(c2, 2), bundle]); assert.equal(r.rc, 10, r.out); assert.equal(state().live.sha, c1); assert.doesNotMatch(r.log, /--no-deps.*gantry-migrate/); });
T("11 unhealthy after a contract migration pages and leaves the new release up", () => {
  base({ live: live(c2, 4), highestStarted: c2, applied: { latest: 4, lastContract: 0 } }); gate(1, 0); const r = run(["deploy", mk(c3, 5, [{ n: 5, after: c1 }]), bundle]); assert.equal(r.rc, 20, r.out); assert.equal(state().live.sha, c3);
});
T("12 a rollback whose own gate fails needs a person", () => { base(); gate(1, 1); assert.equal(run(["deploy", mk(c2, 2), bundle]).rc, 20); });
T("12b a failed `up` is an unhealthy release: rollback or page, never success", () => { base(); gate(); const r = run(["deploy", mk(c2, 2), bundle], { UP_RC: "1" }); assert.ok([10, 20].includes(r.rc), r.out); });
T("13 a lock held by another deploy gives 75", () => {
  st(); const r = spawnSync("bash", ["-c", `exec 8>"${join(SD, "lock")}"; flock -n 8; bash "${join(inst, "gantry-release.sh")}" deploy "${mk(c2, 2)}" "${bundle}"`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG, GANTRY_STATE_DIR: SD, GANTRY_REPOSITORY: "acme/gantry", GANTRY_REPO_DIR: R, GANTRY_ENV_FILE: join(R, "deploy/prod.env") } });
  assert.equal(r.status, 75);
});
T("14 a host that was adopted but never told its running commit refuses a deploy; init records it and then orders the first deploy", () => {
  st({ applied: { latest: 2, lastContract: 0 } }); assert.equal(deploy(mk(c1, 2), {}).rc, 30);
  st(); assert.equal(run(["init", "--applied-latest", "2", "--running-sha", c3]).rc, 0); assert.equal(state().highestStarted, c3);
  const old = deploy(mk(c2, 2), {}); assert.equal(old.rc, 30); assert.match(old.out, /superseded/);
});
T("15 a contract on a host that rolled back to an older release is refused", () => { base({ live: live(c1, 3), applied: { latest: 5, lastContract: 0 } }); assert.equal(deploy(mk(c3, 6, [{ n: 6, after: c2 }]), {}).rc, 30); });
T("16 rollback past an applied contract migration needs a person", () => { st({ live: live(c2, 6), previous: live(c1, 5), applied: { latest: 6, lastContract: 6 } }); assert.equal(run(["rollback"]).rc, 20); });
T("17 a host without GANTRY_REPO_DIR fails closed", () => { st(); const r = run(["deploy", mk(c2, 2), bundle], { GANTRY_REPO_DIR: "" }); assert.equal(r.rc, 2); assert.equal(r.saw("^docker"), 0); });
