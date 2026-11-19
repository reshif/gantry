import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkDir } from "./workflow-policy.mjs";

const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const head = (on = "pull_request") => `name: t\non:\n  ${on}:\npermissions:\n  contents: read\njobs:\n`;
const job = (body) => `  a:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;

test("this repository's workflows pass", () => {
  assert.deepEqual(checkDir(join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows")), []);
});
test("an action pinned by tag or branch is refused; a full commit SHA passes", () => {
  assert.match(check("w.yml", head() + job("      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n")).join(), /not pinned/);
  assert.deepEqual(check("w.yml", head() + job(`      - uses: actions/checkout@${sha} # v7\n        with:\n          persist-credentials: false\n`)), []);
});
test("checkout must not persist credentials", () => {
  assert.match(check("w.yml", head() + job(`      - uses: actions/checkout@${sha}\n      - run: echo\n`)).join(), /persist-credentials/);
});
test("permissions must be declared and not write-all", () => {
  assert.match(check("w.yml", "name: t\non:\n  push:\njobs:\n" + job("      - run: echo\n")).join(), /no top-level permissions/);
  assert.match(check("w.yml", "name: t\non:\n  push:\npermissions: write-all\njobs:\n" + job("      - run: echo\n")).join(), /write-all/);
});
test("pull_request_target is refused", () => {
  assert.match(check("w.yml", head("pull_request_target") + job("      - run: echo\n")).join(), /pull_request_target/);
});
test("a secret in a pull request workflow is refused, GITHUB_TOKEN is fine", () => {
  assert.match(check("w.yml", head() + job("      - run: echo\n        env:\n          K: ${{ secrets.DEPLOY_KEY }}\n")).join(), /secret/);
  assert.deepEqual(check("w.yml", head() + job("      - run: echo\n        env:\n          K: ${{ secrets.GITHUB_TOKEN }}\n")), []);
});
test("a self-hosted runner needs an environment and no pull request trigger", () => {
  const sh = (env, on) => head(on) + `  a:\n    runs-on: [self-hosted, linux]\n${env}    steps:\n      - run: echo\n`;
  assert.match(check("w.yml", sh("", "workflow_dispatch")).join(), /without an environment/);
  assert.deepEqual(check("w.yml", sh("    environment: prod\n", "workflow_dispatch")), []);
  assert.match(check("w.yml", sh("    environment: prod\n", "pull_request")).join(), /pull requests can trigger/);
});
test("an untrusted expression in a shell is refused, through env it passes", () => {
  assert.match(check("w.yml", head() + job("      - run: |\n          echo ${{ github.event.pull_request.title }}\n")).join(), /untrusted/);
  assert.match(check("w.yml", head() + job("      - run: echo ${{ github.head_ref }}\n")).join(), /untrusted/);
  assert.deepEqual(check("w.yml", head() + job("      - run: echo \"$T\"\n        env:\n          T: ${{ github.event.pull_request.title }}\n")), []);
});
test("a workflow_run workflow must be gated on a successful push to main of this repository", () => {
  assert.match(check("w.yml", head("workflow_run") + job("      - run: echo\n")).join(), /must be gated/);
});
