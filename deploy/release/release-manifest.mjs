#!/usr/bin/env node
// The release manifest: the one small file that says what a release IS, so that staging, production and a rollback all use
// the same facts. CI writes it after every image is pushed, scanned and signed, signs it (cosign sign-blob, keyless) and
// uploads it; deploy/release/gantry-release.sh verifies that signature before it trusts a byte of it.
//
//   release-manifest.mjs build --sha SHA --repository OWNER/NAME --run-id ID --image api=sha256:... [--image ...]   > release.json
//   release-manifest.mjs validate release.json [--sha SHA]       exit 1 and say why when it is not a well-formed manifest
//   release-manifest.mjs get release.json KEY                    print one value (images.api.digest, migrations.lastContract, ...)
//
// migrations.latest       the highest migration number this release applies (its schema level)
// migrations.lastContract the highest migration number in this tree that is a contract (deploy/ci/migration-safety.mjs); 0 = none.
//   A release can be rolled back TO a release R only if no contract migration above R.migrations.latest has been applied.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIR, info } from "../ci/migration-safety.mjs";
import { readdirSync } from "node:fs";

export const IMAGES = ["api", "worker", "migrate", "launcher", "edge", "github", "web", "runner", "keycloak", "backup"];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function build({ sha, repository, runId, images, migrations }) {
  return {
    schema: 1,
    sha,
    repository: repository.toLowerCase(),
    run: { id: String(runId) },
    images: Object.fromEntries(IMAGES.filter((n) => n in images).map((n) => [n, { ref: `ghcr.io/${repository.toLowerCase().split("/")[0]}/gantry-${n}`, digest: images[n] }])),
    migrations,
  };
}

export function validate(m, { sha } = {}) {
  const bad = [];
  if (!m || typeof m !== "object") return ["not an object"];
  if (m.schema !== 1) bad.push("schema must be 1");
  if (!SHA.test(m.sha ?? "")) bad.push("sha must be 40 hex characters");
  if (sha && m.sha !== sha) bad.push(`sha is ${m.sha}, expected ${sha}`);
  if (!REPO.test(m.repository ?? "")) bad.push("repository must be owner/name");
  for (const n of IMAGES) {
    const i = m.images?.[n];
    if (!i) { bad.push(`image ${n} is missing`); continue; }
    if (!DIGEST.test(i.digest ?? "")) bad.push(`image ${n}: digest must be sha256:<64 hex>`);
    if (typeof i.ref !== "string" || /[\s:@]/.test(i.ref)) bad.push(`image ${n}: ref must be a registry path without tag or digest`);
    if (!i.ref?.startsWith(`ghcr.io/${(m.repository ?? "").split("/")[0]}/gantry-`)) bad.push(`image ${n}: ref must be under ghcr.io/${(m.repository ?? "").split("/")[0]}/gantry-`);
  }
  for (const k of Object.keys(m.images ?? {})) if (!IMAGES.includes(k)) bad.push(`unknown image ${k}`);
  const mg = m.migrations;
  if (!Number.isInteger(mg?.latest) || mg.latest < 0) bad.push("migrations.latest must be an integer");
  if (!Number.isInteger(mg?.lastContract) || mg.lastContract < 0 || mg.lastContract > mg.latest) bad.push("migrations.lastContract must be an integer between 0 and latest");
  return bad;
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const flags = (argv) => {
  const o = { image: [] };
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i]?.replace(/^--/, ""); if (k === "image") o.image.push(argv[i + 1]); else o[k] = argv[i + 1]; }
  return o;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (cmd === "build") {
    const f = flags(rest);
    const images = Object.fromEntries(f.image.map((s) => s.split("=")));
    const files = Object.fromEntries(readdirSync(join(root, DIR)).filter((n) => n.endsWith(".sql")).map((n) => [n, readFileSync(join(root, DIR, n), "utf8")]));
    const m = build({ sha: f.sha, repository: f.repository, runId: f["run-id"], images, migrations: (({ latest, lastContract }) => ({ latest, lastContract }))(info(files)) });
    const bad = validate(m, { sha: f.sha });
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(JSON.stringify(m, null, 2));
  } else if (cmd === "validate") {
    const f = flags(rest.slice(1));
    const bad = validate(JSON.parse(readFileSync(rest[0], "utf8")), { sha: f.sha });
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
  } else if (cmd === "get") {
    const v = get(JSON.parse(readFileSync(rest[0], "utf8")), rest[1]);
    if (v === undefined) process.exit(1);
    console.log(typeof v === "object" ? JSON.stringify(v) : v);
  } else { console.error("usage: release-manifest.mjs build|validate|get ..."); process.exit(2); }
}
