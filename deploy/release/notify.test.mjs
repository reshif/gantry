// Model Notify (gate-cicd): the job that tells a person must be able to, whichever of its two channels fails. The workflow's facts:
// `gh issue create` needs a repository (this job has no checkout), and the pager step must not be skipped because the issue step failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const doc = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/deploy.yml"), "utf8"));
const notify = doc.jobs.notify;
const step = (re) => notify.steps.find((s) => re.test(s.name));

test("notify knows the repository (GH_REPO) or checks it out, so gh can open the issue", () => {
  const repoKnown = Boolean(notify.env?.GH_REPO) || notify.steps.some((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
  assert.ok(repoKnown);
  if (notify.env?.GH_REPO) assert.match(notify.env.GH_REPO, /github\.repository/);
});
test("the pager step runs whatever happened before it, and for a failed or needs-a-person verdict", () => {
  const p = step(/pager/i);
  assert.match(p.if, /^always\(\)/);
  assert.match(p.if, /needs-a-person/); assert.match(p.if, /failed/);
});
test("the pager is called before the issue is opened, and the issue step does not depend on the pager's success", () => {
  assert.ok(notify.steps.indexOf(step(/pager/i)) < notify.steps.indexOf(step(/issue/i)));
  assert.match(step(/issue/i).if, /always\(\)/);
});
test("notify runs when the deploy job failed, was cancelled or ended with a verdict other than healthy", () => {
  assert.match(notify.if, /always\(\)/); assert.match(notify.if, /verdict != 'healthy'/);
});
