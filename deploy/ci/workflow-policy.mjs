#!/usr/bin/env node
// The pipeline's own rules, checked on every pull request (deploy-config job), so a change to a workflow cannot quietly weaken them.
// Workflows are parsed with a real YAML parser (the `yaml` package), never read with indentation regexes.
//   1 supply chain  every `uses:` is pinned to a full commit SHA (or an image digest); every actions/checkout sets persist-credentials: false
//   2 privilege     every workflow declares top-level `permissions:` and none is write-all
//   3 forks         no pull_request_target; no secret other than GITHUB_TOKEN in a workflow a pull request or merge queue can run;
//                   a workflow_run workflow's entry jobs only react to a successful push to main of this repository
//   4 the host      a job whose runs-on names `self-hosted` or `gantry-prod` is allowed ONLY in .github/workflows/deploy.yml, ONLY with
//                   `environment: production-deploy`, and never in a workflow a pull request can trigger. This check runs from the
//                   pull request's own tree, so it is a guard against mistakes, not a boundary against someone who can push a branch:
//                   the boundary is the owner's setting "runner group restricted to deploy.yml@refs/heads/main" (CICD.md, go/no-go)
//                   and the production-deploy Environment's branch rule (deploy/ci/github-settings.sh)
//   5 injection     no attacker-controlled expression (branch or tag name, PR title/body, review/comment text, commit message,
//                   workflow_run branch, workflow inputs) inside a `run:` block or an actions/github-script `script:`; pass it through env:
// Usage: node deploy/ci/workflow-policy.mjs [DIR]   (default .github/workflows); exit 1 and one line per violation.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$|^docker:\/\/\S+@sha256:[0-9a-f]{64}$|^\.\//;
const UNTRUSTED = [
  /\bgithub\.(head_ref|base_ref|ref_name|ref)\b/,
  /\bgithub\.event\.(pull_request\.(title|body|head\.|user\.|labels)|issue\.(title|body)|comment\.|review\.|review_comment\.|discussion\.|head_commit\.|commits\b|pages\b|workflow_run\.(head_branch|head_commit|display_title|head_repository|pull_requests)|inputs\b|client_payload\b)/,
  /(^|[^\w.])inputs\./,
];
const WORKFLOW_RUN_GATE = ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_repository.full_name == github.repository"];

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const triggersOf = (on) => new Set(typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {}));
const labelsOf = (r) => (r == null ? [] : typeof r === "string" ? [r] : Array.isArray(r) ? r.map(String) : [...arr(r.labels), r.group].filter(Boolean).map(String));
const untrusted = (s) => [...String(s ?? "").matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).filter((e) => UNTRUSTED.some((re) => re.test(e)));

/** Violations (strings) for one workflow file's text; `file` is the path relative to the repository root. */
export function check(file, text) {
  const bad = [];
  const add = (where, msg) => bad.push(`${file}${where ? ` ${where}` : ""}: ${msg}`);
  let doc;
  try { doc = parse(text); } catch (e) { return [`${file}: not valid YAML (${e.message.split("\n")[0]})`]; }
  if (!doc || typeof doc !== "object" || !doc.jobs) return [`${file}: no jobs`];
  const triggers = triggersOf(doc.on ?? doc[true]);
  const forkReachable = ["pull_request", "merge_group", "pull_request_target"].some((t) => triggers.has(t));
  const isDeploy = file.replace(/\\/g, "/").endsWith(".github/workflows/deploy.yml") || file === "deploy.yml";

  if (!doc.permissions) add("", "no top-level permissions: (least privilege: start from contents: read)");
  if (doc.permissions === "write-all") add("", "permissions: write-all");
  if (triggers.has("pull_request_target")) add("", "pull_request_target runs with secrets on code from a fork; do not use it");

  for (const [jid, job] of Object.entries(doc.jobs)) {
    const w = `job ${jid}`;
    if (job.permissions === "write-all") add(w, "permissions: write-all");
    const labels = labelsOf(job["runs-on"]);
    if (labels.some((l) => /self-hosted|gantry-prod/i.test(l))) {
      const env = typeof job.environment === "string" ? job.environment : job.environment?.name;
      if (!isDeploy) add(w, "a self-hosted runner (the production host) may be used only by .github/workflows/deploy.yml");
      if (env !== "production-deploy") add(w, "a self-hosted job must use environment: production-deploy (its branch rule and variables are what protect the host)");
      if (forkReachable) add(w, "a self-hosted runner in a workflow that pull requests or the merge queue can trigger");
    }
    if (labels.some((l) => l.includes("${{"))) add(w, "runs-on is an expression: it cannot be checked against the self-hosted rule");
    if (triggers.has("workflow_run") && !job.needs) {
      const cond = String(job.if ?? "");
      for (const need of WORKFLOW_RUN_GATE) if (!cond.includes(need)) add(w, `an entry job of a workflow_run workflow must be gated on ${need}`);
    }
    for (const [i, step] of arr(job.steps).entries()) {
      const at = `${w} step ${i + 1}${step.name ? ` (${step.name})` : ""}`;
      if (step.uses) {
        if (!PINNED.test(step.uses)) add(at, `uses: ${step.uses} is not pinned to a full commit SHA`);
        if (/^actions\/checkout@/.test(step.uses) && String(step.with?.["persist-credentials"]) !== "false") add(at, "actions/checkout without persist-credentials: false");
        if (/^actions\/github-script@/.test(step.uses) && untrusted(step.with?.script).length) add(at, "an untrusted expression inside a github-script script: pass it through env: and read process.env");
      }
      if (untrusted(step.run).length) add(at, `an untrusted expression (${untrusted(step.run)[0].trim()}) inside run: pass it through env: and quote the variable`);
    }
  }
  if (forkReachable && /\bsecrets\.(?!GITHUB_TOKEN\b)\w+/.test(JSON.stringify(doc))) add("", "a secret in a workflow that pull requests or the merge queue can run (forks get none, and a branch of this repository should not need one)");
  return bad;
}

export function checkDir(dir, prefix = ".github/workflows") {
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().flatMap((f) => check(`${prefix}/${f}`, readFileSync(join(dir, f), "utf8")));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(resolve(fileURLToPath(import.meta.url), "../../.."), ".github/workflows");
  const bad = checkDir(dir);
  for (const b of bad) console.log(`::error title=Workflow policy::${b}`);
  if (bad.length) process.exit(1);
  console.log(`workflow policy: ${readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).length} workflows ok`);
}
