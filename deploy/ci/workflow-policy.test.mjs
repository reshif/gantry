import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkDir } from "./workflow-policy.mjs";

const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
// Any indentation is valid YAML; the policy must not depend on it.
const wf = ({ on = "pull_request", perms = "permissions:\n  contents: read\n", job = "    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n" } = {}) =>
  `name: t\non:\n  ${on}:\n${perms}jobs:\n  a:\n${job}`;
const W = (o, f = ".github/workflows/w.yml") => check(f, wf(o));
const step = (s) => `    runs-on: ubuntu-24.04\n    steps:\n${s}`;

test("this repository's workflows pass", () => {
  assert.deepEqual(checkDir(join(dirname(fileURLToPath(import.meta.url)), "../../.github/workflows")), []);
});
test("an action pinned by tag or branch is refused; a full commit SHA passes", () => {
  assert.match(W({ job: step("      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n") }).join(), /not pinned/);
  assert.deepEqual(W({ job: step(`      - uses: actions/checkout@${sha}\n        with:\n          persist-credentials: false\n`) }), []);
});
test("checkout must not persist credentials", () => {
  assert.match(W({ job: step(`      - uses: actions/checkout@${sha}\n      - run: echo\n`) }).join(), /persist-credentials/);
});
test("permissions must be declared and not write-all", () => {
  assert.match(W({ perms: "" }).join(), /no top-level permissions/);
  assert.match(W({ perms: "permissions: write-all\n" }).join(), /write-all/);
});
test("pull_request_target is refused, also when the file is indented with four spaces", () => {
  assert.match(W({ on: "pull_request_target" }).join(), /pull_request_target/);
  assert.match(check("w.yml", "name: t\non:\n    pull_request_target:\npermissions:\n    contents: read\njobs:\n    a:\n        runs-on: ubuntu-24.04\n        steps:\n            - run: echo\n").join(), /pull_request_target/);
});
test("a secret in a pull request workflow is refused, GITHUB_TOKEN is fine", () => {
  assert.match(W({ job: step("      - run: echo\n        env:\n          K: ${{ secrets.DEPLOY_KEY }}\n") }).join(), /secret/);
  assert.deepEqual(W({ job: step("      - run: echo\n        env:\n          K: ${{ secrets.GITHUB_TOKEN }}\n") }), []);
});

// G-C5: the production host is reachable only from deploy.yml, only with environment production-deploy.
const sh = (env, on = "workflow_dispatch", labels = "[self-hosted, linux, gantry-prod]") => wf({ on, job: `    runs-on: ${labels}\n${env}    steps:\n      - run: echo\n` });
test("a self-hosted or gantry-prod job needs environment production-deploy and the file deploy.yml", () => {
  assert.match(check(".github/workflows/deploy.yml", sh("")).join(), /environment: production-deploy/);
  assert.match(check(".github/workflows/deploy.yml", sh("    environment: whatever\n")).join(), /environment: production-deploy/);
  assert.deepEqual(check(".github/workflows/deploy.yml", sh("    environment: production-deploy\n")), []);
  assert.deepEqual(check(".github/workflows/deploy.yml", sh("    environment:\n      name: production-deploy\n")), []);
  assert.match(check(".github/workflows/other.yml", sh("    environment: production-deploy\n")).join(), /only by .*deploy\.yml/);
  assert.match(check(".github/workflows/deploy.yml", sh("    environment: production-deploy\n", "pull_request")).join(), /pull requests or the merge queue/);
  assert.match(check(".github/workflows/other.yml", sh("    environment: production-deploy\n", "push", "gantry-prod")).join(), /only by/);
  assert.match(check(".github/workflows/other.yml", sh("    environment: production-deploy\n", "push", "${{ inputs.runner }}")).join(), /expression/);
});

test("an untrusted expression in a shell is refused: PR text, branch and tag names, inputs, review text; through env it passes", () => {
  for (const e of ["github.event.pull_request.title", "github.head_ref", "github.ref_name", "github.ref", "inputs.sha", "github.event.inputs.sha", "github.event.review.body", "github.event.pull_request.head.repo.full_name", "github.event.workflow_run.head_branch", "github.event.head_commit.message"])
    assert.match(W({ job: step(`      - run: |\n          echo \${{ ${e} }}\n`) }).join(), /untrusted/, e);
  assert.deepEqual(W({ job: step("      - run: echo \"$T\"\n        env:\n          T: ${{ github.ref_name }}\n") }), []);
  assert.deepEqual(W({ job: step("      - run: echo ${{ github.sha }} ${{ matrix.name }}\n") }), []);
});
test("an untrusted expression in a github-script script is refused", () => {
  assert.match(W({ job: step(`      - uses: actions/github-script@${sha}\n        with:\n          script: |\n            core.info("\${{ github.event.pull_request.title }}")\n`) }).join(), /github-script/);
});
test("a workflow_run workflow's entry job must be gated on a successful push to main of this repository", () => {
  assert.match(W({ on: "workflow_run" }).join(), /must be gated/);
  const gate = ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_repository.full_name == github.repository"].join(" && ");
  assert.deepEqual(W({ on: "workflow_run", job: `    if: ${gate}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n` }), []);
});

test("YAML anchors, aliases and merge keys are refused outright", () => {
  const base = "name: t\non:\n  push:\npermissions:\n  contents: read\njobs:\n";
  assert.match(check("w.yml", `${base}  a: &job\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n  b: *job\n`).join(), /anchor|alias/);
  assert.match(check("w.yml", `${base}  a:\n    runs-on: ubuntu-24.04\n    env: &e\n      A: "1"\n    steps:\n      - run: echo\n`).join(), /not allowed in workflow files/);
  assert.match(check("w.yml", `${base}  a:\n    <<: {runs-on: ubuntu-24.04}\n    steps:\n      - run: echo\n`).join(), /merge key/);
});
test("a whole-context dump in a shell is refused: toJSON(github), toJSON(github.event), toJSON(inputs), toJSON(secrets)", () => {
  for (const e of ["toJSON(github)", "toJSON(github.event)", "toJSON(inputs)", "toJSON(secrets)", "toJSON(env)", "format('{0}', toJSON(needs))", "github.event"])
    assert.match(W({ job: step(`      - run: |\n          echo '\${{ ${e} }}'\n`) }).join(), /untrusted/, e);
  assert.deepEqual(W({ job: step("      - run: echo ${{ toJSON(matrix) }}\n") }), []);
});
