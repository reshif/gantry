import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPO, gitSync, makeRemote, startEnv, type Env } from "./harness.js";

let env: Env;
let base = "";
let n = 0;
const FILES = { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n", "src/old.ts": "gone soon\n" };

beforeAll(async () => { env = await startEnv(); base = await makeRemote(env, FILES); });
afterAll(() => env.close());

/** Seeds a workspace through the broker, then lets the "runner" commit in it. */
async function workspace(): Promise<{ volume: string; dir: string; woId: string; attemptId: string }> {
  const i = ++n;
  const volume = `ws-run${i}`;
  const r = await env.call("POST", "/v1/workspaces/seed", { repo: REPO, commit: base, volume });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { volume, dir: env.store.dir(volume), woId: "WO-1", attemptId: `at-${i}` };
}
const run = (dir: string, ...a: string[]) => gitSync(dir, ...a);
async function commitTwo(dir: string): Promise<void> {
  await writeFile(join(dir, "src/b.ts"), "export const b = 2;\n");
  await writeFile(join(dir, "README.md"), "hello\nworld\n");
  run(dir, "add", "-A"); run(dir, "commit", "-q", "-m", "Add b and update readme");
  await run(dir, "rm", "-q", "src/old.ts");
  await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n"); await chmod(join(dir, "run.sh"), 0o755);
  run(dir, "add", "-A"); run(dir, "commit", "-q", "-m", "Remove old, add script");
}
const publish = (w: { volume: string; attemptId: string }, extra: object = {}) =>
  env.call("POST", "/v1/publish", { attemptId: w.attemptId, fencing: 7, repo: REPO, volume: w.volume, branch: "gantry/WO-1", ...extra });

beforeEach(() => { env.gh.requests.length = 0; env.api.calls.length = 0; env.api.factsStatus = 200; env.api.fence = () => ({ allow: true, woId: "WO-1", branch: "gantry/WO-1", repo: REPO }); });

describe("service auth and validation", () => {
  it("needs the service token (healthz excepted) and validates bodies", async () => {
    expect((await env.call("GET", "/healthz", undefined, {})).status).toBe(200);
    expect((await env.call("POST", "/v1/publish", {}, {})).status).toBe(401);
    expect((await env.call("POST", "/v1/publish", {}, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await env.call("POST", "/v1/publish", { attemptId: "a" })).status).toBe(422);
    expect((await env.call("POST", "/v1/workspaces/seed", { repo: REPO, commit: "abc", volume: "ws-x" })).status).toBe(422);
    expect((await env.call("POST", "/v1/workspaces/seed", { repo: REPO, commit: base, volume: "../../etc" })).status).toBe(422);
    expect((await env.call("POST", "/v1/workspaces/seed", { repo: REPO, commit: base, volume: "ws-ok", extra: 1 })).status).toBe(422);
  });
});

describe("installation tokens", () => {
  it("are minted per operation for one repository with that operation's least permissions, used instead of the JWT, and revoked", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    env.gh.requests.length = 0;
    expect((await publish(w)).status).toBe(200);
    const minted = env.gh.of("POST", /access_tokens$/);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.path).toBe("/app/installations/77/access_tokens");
    expect(minted[0]!.body).toEqual({ repositories: ["payments-api"], permissions: { contents: "write", pull_requests: "write", metadata: "read" } });
    expect(minted[0]!.auth).toMatch(/^bearer eyJ/i); // the App JWT, used only to mint
    const repoCalls = env.gh.requests.filter((r) => r.path.startsWith("/repos/") && !r.path.endsWith("/installation"));
    expect(repoCalls.length).toBeGreaterThan(5);
    for (const r of repoCalls) expect(r.auth).toMatch(/ghs_fake\d+$/);
    expect(new Set(repoCalls.map((r) => r.auth)).size).toBe(1);
    expect(env.gh.of("DELETE", /\/installation\/token$/)).toHaveLength(1);
    expect([...env.gh.tokens.values()].every((t) => t.revoked)).toBe(true);
  });
  it("differ by operation and never exceed the spec 11.1 permission set", async () => {
    env.gh.pulls.length = 0;
    const pr = env.gh.addPull({ number: 90, head: { sha: base, ref: "gantry/WO-1" } });
    await env.call("GET", `/v1/pull-state?repo=${REPO}&number=${pr.number}`);
    await env.call("POST", "/v1/checks/gate", { woId: "WO-1", repo: REPO, headSha: base, state: "pending" });
    const perms = env.gh.of("POST", /access_tokens$/).map((r) => r.body.permissions);
    expect(perms[0]).toEqual({ pull_requests: "read", checks: "read", statuses: "read", actions: "read", issues: "read", contents: "read", metadata: "read" });
    expect(perms[1]).toEqual({ checks: "write", pull_requests: "read", metadata: "read" });
    const allowed = new Set(["metadata", "contents", "pull_requests", "issues", "checks", "actions", "statuses", "administration"]);
    for (const p of perms) for (const k of Object.keys(p)) expect(allowed.has(k)).toBe(true);
  });
  it("a permission the App does not hold is refused by GitHub and surfaces as an error, with no write attempted", async () => {
    const saved = env.gh.appPermissions.checks;
    delete env.gh.appPermissions.checks;
    env.gh.checkRuns.length = 0;
    try {
      const r = await env.call("POST", "/v1/checks/gate", { woId: "WO-1", repo: REPO, headSha: base, state: "passing" });
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("token");
      expect(env.gh.checkRuns).toHaveLength(0);
    } finally { env.gh.appPermissions.checks = saved!; }
  });
});

describe("seed", () => {
  it("clones at the recorded commit with hooks off and no repo config, into the volume owned by the runner", async () => {
    const w = await workspace();
    expect(await readFile(join(w.dir, "src/a.ts"), "utf8")).toBe(FILES["src/a.ts"]);
    expect(run(w.dir, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(join(w.dir, ".git/shallow"))).toBe(true);
    expect(existsSync(join(w.dir, ".git/hooks"))).toBe(false); // empty template: no sample hooks either
    const cfg = await readFile(join(w.dir, ".git/config"), "utf8");
    expect(cfg).not.toMatch(/extraheader|Authorization|ghs_|x-access-token/i);
    const mint = env.gh.of("POST", /access_tokens$/).at(-1)!;
    expect(mint.body).toEqual({ repositories: ["payments-api"], permissions: { contents: "read", metadata: "read" } });
  });
  it("refuses a commit that does not exist", async () => {
    const r = await env.call("POST", "/v1/workspaces/seed", { repo: REPO, commit: "1".repeat(40), volume: "ws-nope" });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("fetch_failed");
  });
});

describe("publish", () => {
  beforeEach(() => { env.gh.refs.delete("refs/heads/gantry/WO-1"); env.gh.pulls.length = 0; });
  it("re-creates the commits through the git data API, opens the pull request and stores the record", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    const localTrees = [run(w.dir, "rev-parse", "HEAD~1^{tree}"), run(w.dir, "rev-parse", "HEAD^{tree}")];
    env.gh.requests.length = 0;
    const r = await publish(w, { title: "WO-1: do it", body: "details" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, branch: "gantry/WO-1", noop: false, alreadyPublished: false, pullRequest: { created: true } });
    expect(r.body.commits).toHaveLength(2);

    // The shape of the calls: blobs, then trees based on the previous tree, then commits chained from the base, then the ref, then the PR.
    const order = env.gh.writes().map((x) => `${x.method} ${x.path.replace(/^\/repos\/acme\/payments-api/, "")}`);
    expect(order.filter((o) => o.endsWith("/git/blobs"))).toHaveLength(3); // b.ts, README, run.sh (a.ts is unchanged, old.ts is deleted)
    expect(order.indexOf("POST /git/refs")).toBeGreaterThan(order.lastIndexOf("POST /git/commits"));
    expect(order.at(-1)).toBe("POST /pulls");
    const trees = env.gh.of("POST", /\/git\/trees$/).map((x) => x.body);
    expect(trees[0].base_tree).toBe(env.gh.commits.get(base)!.tree);
    expect(trees[0].tree.map((e: any) => e.path).sort()).toEqual(["README.md", "src/b.ts"]);
    expect(trees[1].tree.find((e: any) => e.path === "src/old.ts")).toMatchObject({ sha: null });
    expect(trees[1].tree.find((e: any) => e.path === "run.sh")).toMatchObject({ mode: "100755", type: "blob" });
    const commits = env.gh.of("POST", /\/git\/commits$/).map((x) => x.body);
    expect(commits[0].parents).toEqual([base]);
    expect(commits[1].parents).toEqual([r.body.commits[0].sha]);
    expect(commits[0].message).toContain("Add b and update readme");
    expect(commits[0].message).toMatch(/Gantry-Work-Order: WO-1/);
    expect(commits[0].author).toBeUndefined(); // the App is the author, so GitHub marks them verified
    // What GitHub holds has exactly the trees git computed locally.
    expect(r.body.commits.map((c: any) => env.gh.commits.get(c.sha)!.tree)).toEqual(localTrees);
    expect(env.gh.refs.get("refs/heads/gantry/WO-1")).toBe(r.body.headSha);
    expect(env.gh.of("POST", /\/pulls$/)[0]!.body).toMatchObject({ title: "WO-1: do it", head: "gantry/WO-1", base: "main", body: "details", draft: false });

    // Fence was asked first (and again before the branch moved), with the attempt's number.
    expect(env.api.fences()).toHaveLength(2);
    expect(env.api.fences()[0]).toMatchObject({ path: `/internal/v1/attempts/${w.attemptId}/fence-check`, body: { fencing: 7, purpose: "publish", repo: REPO } });
    // The record: ids, per-file stats and patches.
    const facts = env.api.facts();
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f.source).toBe("publish");
    expect(f.publish).toMatchObject({ attemptId: w.attemptId, woId: "WO-1", branch: "gantry/WO-1", prNumber: r.body.pullRequest.number });
    const c1 = f.publish.commits[0];
    expect(c1).toMatchObject({ sha: r.body.commits[0].sha, localSha: run(w.dir, "rev-parse", "HEAD~1"), parents: [base] });
    expect(c1.files).toEqual(expect.arrayContaining([{ path: "src/b.ts", status: "added", additions: 1, deletions: 0 }, { path: "README.md", status: "modified", additions: 1, deletions: 0 }]));
    expect(c1.patch).toContain("+export const b = 2;");
    expect(f.publish.commits[1].files).toEqual(expect.arrayContaining([{ path: "src/old.ts", status: "removed", additions: 0, deletions: 1 }]));
    expect(f.pullRequests[0]).toMatchObject({ number: r.body.pullRequest.number, headSha: r.body.headSha, headBranch: "gantry/WO-1", state: "open" });
  });

  it("never executes anything from the workspace: hostile repo config and hooks are not read", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    const marker = join(env.root, "pwned");
    await appendFile(join(w.dir, ".git/config"), `\n[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = ${join(w.dir, ".git/evil")}\n[diff]\n\texternal = touch ${marker}\n[alias]\n\tshow = !touch ${marker}\n`);
    await mkdir(join(w.dir, ".git/hooks"), { recursive: true });
    await writeFile(join(w.dir, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    // An alternates file that points outside the workspace must not be followed either.
    await mkdir(join(w.dir, ".git/objects/info"), { recursive: true });
    await writeFile(join(w.dir, ".git/objects/info/alternates"), "/etc\n");
    const r = await publish(w);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish symlinks and submodules, and malformed objects, before anything is written to GitHub", async () => {
    // a symlink
    let w = await workspace();
    await symlink("/etc/passwd", join(w.dir, "link"));
    run(w.dir, "add", "-A"); run(w.dir, "commit", "-q", "-m", "Add a link");
    env.gh.requests.length = 0;
    let r = await publish(w);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body).toMatchObject({ code: "unsupported_entry", path: "link" });
    expect(r.body.msg).toContain("symbolic link");
    expect(env.gh.writes()).toHaveLength(0);
    // a submodule (a gitlink entry)
    w = await workspace();
    run(w.dir, "update-index", "--add", "--cacheinfo", `160000,${base},vendor/lib`);
    run(w.dir, "commit", "-q", "-m", "Add a submodule");
    r = await publish(w);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body).toMatchObject({ code: "unsupported_entry", path: "vendor/lib" });
    expect(r.body.msg).toContain("submodule");
    expect(env.gh.writes()).toHaveLength(0);
    // a commit object with no author or committer: git's own fsck rejects it
    w = await workspace();
    const tree = run(w.dir, "rev-parse", "HEAD^{tree}");
    const bad = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: w.dir, input: `tree ${tree}\nparent ${base}\n\nno author here\n`, encoding: "utf8" }).trim();
    run(w.dir, "update-ref", "HEAD", bad);
    r = await publish(w);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("fsck_failed");
    expect(env.gh.writes()).toHaveLength(0);
  });

  it("refuses a superseded attempt before anything is written to GitHub", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    env.gh.requests.length = 0;
    env.api.fence = () => ({ allow: false, code: "superseded", reason: "This attempt was superseded by a newer one (fencing number changed)." });
    const r = await publish(w);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: "fenced", fence: "superseded" });
    expect(env.gh.requests).toHaveLength(0); // no token minted either
    expect(env.api.facts()).toHaveLength(0);
  });

  it("fails closed when the API cannot be reached", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    env.gh.requests.length = 0;
    env.api.fence = () => { throw new Error("boom"); };
    const r = await publish(w);
    expect(r.status).toBe(503);
    expect(env.gh.requests).toHaveLength(0);
  });

  it("checks the fence again before moving the branch: an attempt superseded mid-publish does not move it", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    env.api.fence = (_c, count) => (count === 1 ? { allow: true, woId: "WO-1", branch: "gantry/WO-1", repo: REPO } : { allow: false, code: "stopped", reason: "Halted at wo scope." });
    env.gh.refs.delete("refs/heads/gantry/WO-1");
    env.gh.pulls.length = 0;
    const r = await publish(w);
    expect(r.status).toBe(409);
    expect(r.body.fence).toBe("stopped");
    expect(env.gh.refs.has("refs/heads/gantry/WO-1")).toBe(false);
    expect(env.gh.of("POST", /\/pulls$/)).toHaveLength(0);
  });

  it("refuses a branch that is not the work order's", async () => {
    const w = await workspace();
    await commitTwo(w.dir);
    const r = await publish(w, { branch: "gantry/WO-999" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("bad_branch");
  });

  it("is idempotent: a retry reuses the commits already on the branch and re-sends the record", async () => {
    env.gh.refs.delete("refs/heads/gantry/WO-1"); env.gh.pulls.length = 0;
    const w = await workspace();
    await commitTwo(w.dir);
    const first = await publish(w);
    expect(first.status).toBe(200);
    env.gh.requests.length = 0; env.api.calls.length = 0;
    const again = await publish(w);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ alreadyPublished: true, headSha: first.body.headSha, pullRequest: { created: false, number: first.body.pullRequest.number } });
    expect(again.body.commits).toEqual(first.body.commits);
    expect(env.gh.of("POST", /git\/(blobs|trees|commits|refs)/)).toHaveLength(0);
    expect(env.api.facts()[0].publish.commits.map((c: any) => c.sha)).toEqual(first.body.commits.map((c: any) => c.sha));
  });

  it("refuses when the branch moved away from the base, and when history is not linear", async () => {
    const other = env.gh.seedCommit({ "x.txt": "other" }, base, "someone else");
    env.gh.setRef("refs/heads/gantry/WO-1", other);
    env.gh.pulls.length = 0;
    const w = await workspace();
    await commitTwo(w.dir);
    const moved = await publish(w);
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("branch_moved");
    env.gh.refs.delete("refs/heads/gantry/WO-1");
    const w2 = await workspace();
    run(w2.dir, "checkout", "-q", "-b", "side"); await writeFile(join(w2.dir, "s.txt"), "s"); run(w2.dir, "add", "-A"); run(w2.dir, "commit", "-q", "-m", "side");
    run(w2.dir, "checkout", "-q", "--detach", base); await writeFile(join(w2.dir, "m.txt"), "m"); run(w2.dir, "add", "-A"); run(w2.dir, "commit", "-q", "-m", "main side");
    run(w2.dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const merged = await publish(w2);
    expect(merged.status).toBe(422);
    expect(merged.body.code).toBe("non_linear");
  });

  it("publishes nothing when the workspace has no new commits", async () => {
    const w = await workspace();
    env.gh.requests.length = 0;
    const r = await publish(w);
    expect(r.body).toMatchObject({ ok: true, noop: true, commits: [] });
    expect(env.gh.writes()).toHaveLength(0);
  });

  it("reports a record that could not be stored, with the branch already published", async () => {
    env.gh.refs.delete("refs/heads/gantry/WO-1"); env.gh.pulls.length = 0;
    const w = await workspace();
    await commitTwo(w.dir);
    env.api.factsStatus = 503;
    const r = await publish(w);
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("record_not_stored");
    env.api.factsStatus = 200;
    expect((await publish(w)).body).toMatchObject({ ok: true, alreadyPublished: true });
  });

  it("truncates an oversized patch but still records the file stats", async () => {
    env.gh.refs.delete("refs/heads/gantry/WO-1"); env.gh.pulls.length = 0;
    const w = await workspace();
    await writeFile(join(w.dir, "big.txt"), Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n"));
    run(w.dir, "add", "-A"); run(w.dir, "commit", "-q", "-m", "big");
    const r = await publish(w);
    expect(r.status).toBe(200);
    const c = env.api.facts().at(-1).publish.commits[0];
    expect(c.patchTruncated).toBe(true);
    expect(c.files[0]).toMatchObject({ path: "big.txt", status: "added", additions: 20000 });
  });
});

describe("merge", () => {
  const prAt = (head: string) => { env.gh.pulls.length = 0; return env.gh.addPull({ number: 30, head: { sha: head, ref: "gantry/WO-1" } }); };
  const merge = (head: string, extra: object = {}) => env.call("POST", "/v1/pulls/merge", { woId: "WO-1", repo: REPO, number: 30, headSha: head, ...extra });

  it("merges exactly the approved commit with the expected sha and reports the merge to Gantry", async () => {
    const head = "a".repeat(40);
    prAt(head);
    const r = await merge(head, { method: "squash" });
    expect(r.body).toMatchObject({ ok: true, merged: true, alreadyMerged: false });
    expect(env.gh.of("PUT", /pulls\/30\/merge$/)[0]!.body).toEqual({ sha: head, merge_method: "squash" });
    expect(env.api.fences()[0]).toMatchObject({ path: "/internal/v1/work-orders/WO-1/fence-check", body: { purpose: "merge", repo: REPO } });
    expect(env.gh.of("POST", /access_tokens$/)[0]!.body.permissions).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
    expect(env.api.facts()[0].pullRequests[0]).toMatchObject({ number: 30, state: "merged", headSha: head, mergeCommitSha: r.body.mergeSha });
  });
  it("does not merge when the head moved, and says so", async () => {
    prAt("b".repeat(40));
    const r = await merge("c".repeat(40));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("head_moved");
    expect(env.gh.of("PUT", /merge$/)).toHaveLength(0);
  });
  it("maps GitHub's own refusals (rules not met, head changed at the last moment)", async () => {
    const head = "d".repeat(40);
    prAt(head);
    env.gh.mergeResponse = { status: 405, body: { message: "Required status check is expected." } };
    expect(await merge(head).then((r) => [r.status, r.body.code])).toEqual([409, "not_mergeable"]);
    env.gh.mergeResponse = { status: 409, body: { message: "Head branch was modified." } };
    expect(await merge(head).then((r) => [r.status, r.body.code])).toEqual([409, "head_moved"]);
    env.gh.mergeResponse = null;
  });
  it("is safe to retry: an already merged pull request is not merged twice", async () => {
    const head = "e".repeat(40);
    prAt(head);
    await merge(head);
    env.gh.requests.length = 0;
    const r = await merge(head);
    expect(r.body).toMatchObject({ merged: true, alreadyMerged: true });
    expect(env.gh.of("PUT", /merge$/)).toHaveLength(0);
  });
  it("is refused in a stopped scope without touching GitHub", async () => {
    const head = "f".repeat(40);
    prAt(head);
    env.api.fence = (c) => (c.body.purpose === "merge" ? { allow: false, code: "stopped", reason: "Halted at wo scope." } : { allow: true, woId: "WO-1" });
    env.gh.requests.length = 0;
    const r = await merge(head);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "fenced", fence: "stopped" });
    expect(env.gh.requests).toHaveLength(0);
  });
  it("validates the sha and method", async () => {
    expect((await merge("abc")).status).toBe(422);
    expect((await merge("a".repeat(40), { method: "fast" })).status).toBe(422);
  });
});

describe("the Gantry gate check", () => {
  const set = (state: string, sha = "1".repeat(40)) => env.call("POST", "/v1/checks/gate", { woId: "WO-1", repo: REPO, headSha: sha, state });
  beforeEach(() => { env.gh.checkRuns.length = 0; });

  it("is created passing, failing or pending, and updated in place", async () => {
    const r1 = await set("pending");
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(env.gh.checkRuns[0]).toMatchObject({ name: "Gantry gates", status: "in_progress", head_sha: "1".repeat(40) });
    expect(env.gh.checkRuns[0].conclusion).toBeUndefined();
    await set("passing");
    expect(env.gh.checkRuns).toHaveLength(1);
    expect(env.gh.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(env.gh.of("PATCH", /check-runs\/\d+$/)).toHaveLength(1);
    await set("failing");
    expect(env.gh.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "failure", output: { title: "Blocked by Gantry" } });
    expect(env.api.facts().at(-1).checks[0]).toMatchObject({ name: "Gantry gates", status: "completed", conclusion: "failure" });
  });
  it("uses the purpose that matches the state when asking the API", async () => {
    await set("passing"); await set("failing"); await set("pending");
    expect(env.api.fences().map((c) => c.body.purpose)).toEqual(["check_pass", "check_fail", "check_pending"]);
  });
  it("passing is refused in a stopped scope, failing is not: a stop must reach GitHub", async () => {
    env.api.fence = (c) => (c.body.purpose === "check_fail" ? { allow: true, woId: "WO-1" } : { allow: false, code: "stopped", reason: "Killed at project scope." });
    expect((await set("passing")).status).toBe(409);
    expect(env.gh.checkRuns).toHaveLength(0);
    expect((await set("failing")).status).toBe(200);
    expect(env.gh.checkRuns[0]).toMatchObject({ conclusion: "failure" });
  });
});

describe("convert to draft", () => {
  it("uses GraphQL once and is a no-op for a draft", async () => {
    env.gh.pulls.length = 0;
    env.gh.addPull({ number: 12, head: { sha: "a".repeat(40), ref: "gantry/WO-1" } });
    const r = await env.call("POST", "/v1/pulls/draft", { woId: "WO-1", repo: REPO, number: 12 });
    expect(r.body).toMatchObject({ ok: true, draft: true, alreadyDraft: false });
    const gql = env.gh.of("POST", /^\/graphql$/);
    expect(gql).toHaveLength(1);
    expect(gql[0]!.body.query).toContain("convertPullRequestToDraft");
    expect(gql[0]!.body.variables).toEqual({ id: "PR_12" });
    expect((await env.call("POST", "/v1/pulls/draft", { woId: "WO-1", repo: REPO, number: 12 })).body.alreadyDraft).toBe(true);
    expect(env.gh.of("POST", /^\/graphql$/)).toHaveLength(1);
    expect(env.api.fences()[0]!.body.purpose).toBe("draft");
  });
});

describe("reading state", () => {
  it("returns checks and reviews, and only counts approvals of the current head", async () => {
    env.gh.pulls.length = 0; env.gh.checkRuns.length = 0;
    const head = "9".repeat(40);
    env.gh.addPull({ number: 20, head: { sha: head, ref: "gantry/WO-1" } });
    env.gh.checkRuns.push({ id: 1, name: "ci / test", head_sha: head, status: "completed", conclusion: "success", app: { slug: "actions" } });
    env.gh.reviews.set(20, [
      { id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: "8".repeat(40), submitted_at: "2026-01-01T00:00:00Z", body: "" },
      { id: 2, user: { login: "bob" }, state: "APPROVED", commit_id: head, submitted_at: "2026-01-02T00:00:00Z", body: "ok" },
      { id: 3, user: { login: "carol" }, state: "CHANGES_REQUESTED", commit_id: head, submitted_at: "2026-01-02T00:00:00Z", body: "no" },
    ]);
    const r = await env.call("GET", `/v1/pull-state?repo=${REPO}&number=20`);
    expect(r.status).toBe(200);
    expect(r.body.approvals).toEqual(["bob"]);
    expect(r.body.checks[0]).toMatchObject({ name: "ci / test", conclusion: "success", appSlug: "actions" });
    expect(r.body.reviews).toHaveLength(3);
    expect(r.body.mergeableState).toBe("clean");
    expect((await env.call("GET", `/v1/pull-state?repo=${REPO}&number=999`)).status).toBe(404);
  });
});

describe("repository protections", () => {
  it("reports rulesets and flags the App on a bypass list", async () => {
    env.gh.rulesets = [{ id: 1, name: "main", target: "branch", enforcement: "active", bypass_actors: [{ actor_id: 4242, actor_type: "Integration", bypass_mode: "always" }],
      rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: true } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Gantry gates" }, { context: "ci / test" }] } }] }];
    const r = await env.call("GET", `/v1/protections?repo=${REPO}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ defaultBranch: "main", appOnBypassList: true, requiresGantryCheck: true, serverVersion: "3.14.0", installation: { id: 77, repositorySelection: "selected" } });
    expect(r.body.rulesets[0]).toMatchObject({ approvals: 1, codeOwners: true, requiredChecks: ["Gantry gates", "ci / test"] });
    expect(env.gh.of("POST", /access_tokens$/).at(-1)!.body.permissions).toEqual({ administration: "read", contents: "read", pull_requests: "read", metadata: "read" });
    env.gh.rulesets[0].bypass_actors = [];
    expect((await env.call("GET", `/v1/protections?repo=${REPO}`)).body.appOnBypassList).toBe(false);
    env.gh.rulesets = [];
  });
  it("reads classic branch protection when there are no rulesets", async () => {
    env.gh.protection = { required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true }, required_status_checks: { contexts: ["Gantry gates"] }, enforce_admins: { enabled: true } };
    const r = await env.call("GET", `/v1/protections?repo=${REPO}`);
    expect(r.body.branchProtection).toEqual({ requiresPullRequest: true, approvals: 2, codeOwners: true, requiredChecks: ["Gantry gates"], enforceAdmins: true });
    expect(r.body.requiresGantryCheck).toBe(true);
    env.gh.protection = null;
  });
});

describe("deliveries and polling", () => {
  it("redelivers failed webhook deliveries once", async () => {
    env.gh.deliveries.push(
      { id: 1, guid: "g1", event: "pull_request", delivered_at: "2026-01-01T00:00:00Z", status_code: 502, status: "failed", redelivery: false },
      { id: 2, guid: "g2", event: "check_run", delivered_at: "2026-01-01T00:00:00Z", status_code: 202, status: "OK", redelivery: false },
      { id: 3, guid: "g2", event: "check_run", delivered_at: "2026-01-01T00:00:00Z", status_code: 500, status: "failed", redelivery: true },
    );
    const r = await env.call("POST", "/v1/deliveries/reconcile");
    expect(r.body).toMatchObject({ checked: 3, failed: 1, redelivered: 1 });
    expect(env.gh.of("POST", /hook\/deliveries\/1\/attempts$/)).toHaveLength(1);
    expect((await env.call("GET", "/v1/deliveries")).body.deliveries).toHaveLength(3);
    env.gh.deliveries.length = 0;
  });
  it("polls pull requests on Gantry branches, their checks and reviews, and labelled issues, and sends them as facts", async () => {
    env.gh.pulls.length = 0; env.gh.checkRuns.length = 0; env.gh.reviews.clear();
    const head = "7".repeat(40);
    env.gh.addPull({ number: 1, head: { sha: head, ref: "gantry/WO-1" }, title: "ours" });
    env.gh.addPull({ number: 2, head: { sha: "6".repeat(40), ref: "feature/human" }, title: "not ours" });
    env.gh.checkRuns.push({ id: 9, name: "ci", head_sha: head, status: "in_progress", conclusion: null, app: { slug: "actions" } });
    env.gh.reviews.set(1, [{ id: 5, user: { login: "dana" }, state: "APPROVED", commit_id: head, submitted_at: "2026-01-01T00:00:00Z", body: "" }]);
    env.gh.issues.push({ number: 8, title: "Fix it", labels: [{ name: "gantry" }], user: { login: "erin" }, html_url: "u" }, { number: 9, title: "pr-issue", labels: [{ name: "gantry" }], pull_request: {} }, { number: 10, title: "other", labels: [{ name: "bug" }] });
    const r = await env.call("POST", "/v1/reconcile", { repo: REPO });
    expect(r.body).toMatchObject({ ok: true, pullRequests: 1, checks: 1, reviews: 1, issues: 1, stored: true });
    const f = env.api.facts().at(-1);
    expect(f).toMatchObject({ source: "poll", repo: REPO });
    expect(f.pullRequests.map((p: any) => p.number)).toEqual([1]);
    expect(f.issues).toEqual([expect.objectContaining({ number: 8, labels: ["gantry"] })]);
    expect(f.reviews[0]).toMatchObject({ prNumber: 1, reviewer: "dana", state: "approved" });
  });
  it("sends the default branch tip so Gantry can record the repository's base commit", async () => {
    const tip = "a".repeat(40);
    env.gh.setRef("refs/heads/main", tip);
    const r = await env.call("POST", "/v1/reconcile", { repo: REPO });
    expect(r.body.ok).toBe(true);
    expect(env.api.facts().at(-1).base).toEqual({ branch: "main", sha: tip });
  });
  it("the poll loop asks the API which repositories to poll", async () => {
    env.api.repos = [{ id: "r1", repo: REPO, installationId: null, projectId: "payments", defaultBranch: "main", branchPrefix: "gantry/" }];
    env.api.calls.length = 0;
    await env.poller.tick();
    expect(env.api.calls[0]).toMatchObject({ method: "GET", path: "/internal/v1/github/repos" });
    expect(env.api.facts().length).toBe(1);
    expect(env.poller.lastRun).toMatchObject({ repos: 1, errors: 0 });
    env.api.repos = [];
  });
});
