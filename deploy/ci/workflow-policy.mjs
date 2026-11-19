#!/usr/bin/env node
// The pipeline's own rules, checked on every pull request (deploy-config job), so a change to a workflow cannot quietly weaken them.
// No dependencies: workflows are read line by line, which is enough for these rules and keeps the check runnable anywhere.
//   1 supply chain  every `uses:` is pinned to a full commit SHA (or a digest); every actions/checkout sets persist-credentials: false
//   2 privilege     every workflow declares top-level `permissions:` and none is write-all
//   3 forks         no pull_request_target; no secret other than GITHUB_TOKEN in a workflow a pull request or merge queue can run;
//                   a workflow_run workflow only reacts to a successful push to main of this repository
//   4 the host      `self-hosted` appears only in a job that names an `environment:`, in a workflow with no pull request trigger
//   5 injection     no attacker-controlled expression (PR title/body/branch, commit message, workflow_run branch) inside a `run:` block
// Usage: node deploy/ci/workflow-policy.mjs [DIR]   (default .github/workflows); exit 1 and one line per violation.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$|^docker:\/\/\S+@sha256:[0-9a-f]{64}$|^\.\//;
const UNTRUSTED = /\$\{\{\s*(github\.head_ref|github\.event\.(pull_request\.(title|body|head\.(ref|label)|user\.login)|issue\.(title|body)|comment\.body|head_commit\.(message|author\.(name|email))|commits\b|workflow_run\.(head_branch|head_commit|display_title|head_repository\.full_name)|inputs\b)[^}]*)\s*\}\}/;

/** Violations (strings) for one workflow file's text. */
export function check(name, text) {
  const bad = [];
  const lines = text.split("\n");
  const add = (i, msg) => bad.push(`${name}:${i + 1}: ${msg}`);
  const triggers = new Set();
  let inOn = false;
  for (const l of lines) {
    if (/^on:\s*$/.test(l)) { inOn = true; continue; }
    if (inOn && /^\S/.test(l)) inOn = false;
    if (inOn) { const m = /^ {2}([a-z_]+):/.exec(l); if (m) triggers.add(m[1]); }
    const inline = /^on:\s*\[?([^\]#]+)\]?/.exec(l); if (inline && !/^on:\s*$/.test(l)) inline[1].split(",").forEach((t) => triggers.add(t.trim()));
  }
  if (!/^permissions:/m.test(text)) bad.push(`${name}: no top-level permissions: (least privilege: start from contents: read)`);
  if (/^\s*permissions:\s*write-all/m.test(text)) bad.push(`${name}: permissions: write-all`);
  if (triggers.has("pull_request_target")) bad.push(`${name}: pull_request_target runs with secrets on code from a fork; do not use it`);

  const forkReachable = triggers.has("pull_request") || triggers.has("merge_group") || triggers.has("pull_request_target");
  let inRun = false, runIndent = 0, selfHostedJobs = [];
  let job = null, jobLine = 0, jobHasEnv = false, jobSelfHosted = false;
  const closeJob = () => { if (job && jobSelfHosted && !jobHasEnv) add(jobLine, `job ${job} runs on a self-hosted runner without an environment: (the Environment is the person's approval)`); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const jm = /^ {2}([\w-]+):\s*$/.exec(l);
    if (jm && /^jobs:/m.test(lines.slice(0, i).join("\n")) && !/^\s{4}/.test(l)) { closeJob(); job = jm[1]; jobLine = i; jobHasEnv = false; jobSelfHosted = false; }
    if (/^ {4}environment:/.test(l)) jobHasEnv = true;
    if (/^ {4}runs-on:.*self-hosted/.test(l)) { jobSelfHosted = true; selfHostedJobs.push(job); }
    const code = l.replace(/\s+#.*$/, "");
    const u = /^\s*-?\s*uses:\s*(\S+)/.exec(code);
    if (u && !PINNED.test(u[1])) add(i, `uses: ${u[1]} is not pinned to a full commit SHA`);
    if (u && /^actions\/checkout@/.test(u[1])) {
      let ok = false;
      for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]) && !/^\s*-\s/.test(lines[j]); j++) if (/persist-credentials:\s*false/.test(lines[j])) ok = true;
      if (!ok) add(i, "actions/checkout without persist-credentials: false");
    }
    if (forkReachable && /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)/.test(code)) add(i, "a secret in a workflow that pull requests or the merge queue can run (forks get none, and a branch of this repository should not need one)");
    // run blocks
    const rm = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(l);
    if (rm) {
      runIndent = rm[1].length; inRun = /^[|>]/.test(rm[2]);
      if (!inRun && UNTRUSTED.test(rm[2])) add(i, "an untrusted expression inside run: pass it through env: and quote the variable");
    } else if (inRun) {
      const ind = /^(\s*)/.exec(l)[1].length;
      if (l.trim() && ind <= runIndent) inRun = false;
      else if (UNTRUSTED.test(l)) add(i, "an untrusted expression inside run: pass it through env: and quote the variable");
    }
  }
  closeJob();
  if (selfHostedJobs.length && forkReachable) bad.push(`${name}: a self-hosted runner in a workflow that pull requests can trigger`);
  if (selfHostedJobs.length && !/self-hosted/.test(name) && !/^name:/m.test(text)) bad.push(`${name}: unnamed workflow`);
  if (triggers.has("workflow_run")) {
    for (const need of ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_repository.full_name == github.repository"])
      if (!text.includes(need)) bad.push(`${name}: a workflow_run workflow must be gated on ${need}`);
  }
  return bad;
}

export function checkDir(dir) {
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().flatMap((f) => check(f, readFileSync(join(dir, f), "utf8")));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(resolve(fileURLToPath(import.meta.url), "../../.."), ".github/workflows");
  const bad = checkDir(dir);
  for (const b of bad) console.log(`::error title=Workflow policy::${b}`);
  if (bad.length) process.exit(1);
  console.log(`workflow policy: ${readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).length} workflows ok`);
}
