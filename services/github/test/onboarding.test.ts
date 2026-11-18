import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RepoFacts } from "@gantry/domain";
import { scanText } from "../src/onboarding.js";
import { REPO, makeRemote, startEnv, type Env } from "./harness.js";

let env: Env;
let head = "";
// A credential-shaped string is assembled at run time so no literal one sits in this file.
const fakeToken = (): string => "ghp" + "_" + "x7Kq9".repeat(8).slice(0, 36);
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
  "package-lock.json": "{}",
  "src/index.ts": "export const a = 1;\n",
  "src/config.ts": `export const token = "${fakeToken()}";\n`,
  "README.md": "hello\n",
};

beforeAll(async () => {
  env = await startEnv();
  head = await makeRemote(env, FILES);
  env.gh.refs.set("refs/heads/main", head);
});
afterAll(() => env.close());
beforeEach(() => {
  env.gh.requests.length = 0; env.api.calls.length = 0;
  env.api.onboardingFence = () => ({ allow: true });
  env.gh.protectedRefs.clear(); env.gh.ciOnPush = null; env.gh.pulls.length = 0;
  for (const k of [...env.gh.refs.keys()]) if (k !== "refs/heads/main") env.gh.refs.delete(k);
  env.gh.refs.set("refs/heads/main", head);
  env.gh.appPermissions.workflows = "write";
});

describe("scanText", () => {
  it("reports path, line and rule, never the value", () => {
    const hits = scanText("a.ts", `ok\nconst k = "${fakeToken()}"\n-----BEGIN RSA ${"PRIVATE"} KEY-----\n`);
    expect(hits).toEqual([{ path: "a.ts", line: 2, rule: "github-token" }, { path: "a.ts", line: 3, rule: "private-key" }]);
    expect(JSON.stringify(hits)).not.toContain("x7Kq9");
  });
  it("skips lines over 2000 chars by default but scans them (chunked, seam-safe) for repo context", () => {
    const tok = fakeToken();
    for (const pad of [3000, 1490, 1499]) {
      const line = `${"x ".repeat(pad / 2)}${tok}${" y".repeat(500)}`;
      expect(scanText("m.md", line)).toEqual([]);
      expect(scanText("m.md", line, { longLines: true })).toEqual([{ path: "m.md", line: 1, rule: "github-token" }]);
    }
  });
  it("does not flag low-entropy or placeholder assignments", () => {
    expect(scanText("c.ts", 'const password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).toEqual([]);
    expect(scanText("c.ts", 'const apiKey = "your-api-key-goes-here-1234567890"')).toEqual([]);
    expect(scanText("c.ts", 'const apiKey = "Zx81Kq0LmN4pR7sTuVw2YbC9dEf3GhJ5"')).toHaveLength(1);
  });
});

describe("POST /v1/onboarding/inspect", () => {
  it("reads the tree, the key files, the language, a secrets scan and the protections, with a read-only token", async () => {
    const r = await env.call("POST", "/v1/onboarding/inspect", { repo: REPO });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const facts = RepoFacts.parse({ ...r.body, protection: r.body.protection ?? null });
    expect(facts.headSha).toBe(head);
    expect(facts.files.sort()).toEqual(Object.keys(FILES).sort());
    expect(facts.contents["package.json"]).toContain("vitest run");
    expect(facts.contents["src/index.ts"]).toBeUndefined();
    expect(facts.language).toBe("TypeScript");
    expect(facts.secrets.hits).toEqual([{ path: "src/config.ts", line: 1, rule: "github-token" }]);
    expect(facts.secrets.complete).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(fakeToken());
    const minted = env.gh.of("POST", /access_tokens$/).map((x) => x.body.permissions);
    expect(minted).toContainEqual({ contents: "read", metadata: "read" });
    expect(env.gh.writes()).toEqual([]);
  });

  it("a light read does not scan for secrets", async () => {
    const r = await env.call("POST", "/v1/onboarding/inspect", { repo: REPO, scan: false });
    expect(r.body.secrets).toEqual({ scanned: 0, complete: false, hits: [], skipped: true });
    expect(r.body.contents["package.json"]).toContain("vitest");
  });

  it("says not_installed when the App is not on the repository", async () => {
    env.gh.uninstalled.add("acme/missing");
    const r = await env.call("POST", "/v1/onboarding/inspect", { repo: "acme/missing" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "not_installed" });
    expect(r.body.msg).toContain("not installed on acme/missing");
  });
});

describe("POST /v1/onboarding/file", () => {
  it("reads one file at the given commit with the read-only token, and refuses a path that is not in the tree", async () => {
    const r = await env.call("POST", "/v1/onboarding/file", { repo: REPO, sha: head, path: "src/index.ts" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ path: "src/index.ts", binary: false, content: "export const a = 1;\n" });
    expect(env.gh.writes()).toEqual([]);
    const miss = await env.call("POST", "/v1/onboarding/file", { repo: REPO, sha: head, path: "src/none.ts" });
    expect(miss.status).toBe(404);
    expect(miss.body).toMatchObject({ code: "no_such_file" });
    expect((await env.call("POST", "/v1/onboarding/file", { repo: REPO, sha: "main", path: "a" })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /v1/onboarding/pr", () => {
  const body = (over: Record<string, unknown> = {}) => ({ repo: REPO, branch: "gantry/onboarding", title: "Prepare acme/payments-api for Gantry", body: "Adds files.", files: [{ path: "AGENTS.md", content: "# AGENTS.md\n" }, { path: ".gantry/factory.yml", content: "repo: acme/payments-api\n" }], ...over });

  it("commits the files on a new branch from the default branch and opens one pull request", async () => {
    const r = await env.call("POST", "/v1/onboarding/pr", body());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created: true, changed: true, branch: "gantry/onboarding", number: 1 });
    const tip = env.gh.refs.get("refs/heads/gantry/onboarding")!;
    expect(r.body.headSha).toBe(tip);
    expect(env.gh.commits.get(tip)!.parents).toEqual([head]);
    const flat = env.gh.trees.get(env.gh.commits.get(tip)!.tree)!;
    expect([...flat.keys()].sort()).toEqual([...Object.keys(FILES), ".gantry/factory.yml", "AGENTS.md"].sort());
    expect(env.gh.pulls[0]).toMatchObject({ title: "Prepare acme/payments-api for Gantry", base: { ref: "main" }, head: { ref: "gantry/onboarding" } });
    expect(env.api.calls.filter((c) => c.path === "/internal/v1/onboarding/fence").length).toBeGreaterThanOrEqual(1);
    expect(env.gh.refs.get("refs/heads/main")).toBe(head); // never touches the default branch
    const perms = env.gh.of("POST", /access_tokens$/).map((x) => x.body.permissions);
    expect(perms.at(-1)).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
  });

  it("is idempotent: the same files add no commit and no second pull request; changed content adds one commit to the same pull request", async () => {
    await env.call("POST", "/v1/onboarding/pr", body());
    const tip1 = env.gh.refs.get("refs/heads/gantry/onboarding");
    const again = await env.call("POST", "/v1/onboarding/pr", body());
    expect(again.body).toMatchObject({ created: false, changed: false, number: 1 });
    expect(env.gh.refs.get("refs/heads/gantry/onboarding")).toBe(tip1);
    const upd = await env.call("POST", "/v1/onboarding/pr", body({ files: [{ path: "AGENTS.md", content: "# AGENTS.md\nmore\n" }], comment: "Change requested: more." }));
    expect(upd.body).toMatchObject({ created: false, changed: true, number: 1 });
    expect(env.gh.commits.get(upd.body.headSha)!.parents).toEqual([tip1]);
    expect(env.gh.pulls).toHaveLength(1);
    expect(env.gh.of("POST", /issues\/1\/comments$/)).toHaveLength(1);
  });

  it("asks for the workflows permission only when a workflow file is added", async () => {
    const wf = body({ branch: "gantry/onboarding-wf", files: [{ path: ".github/workflows/gantry-ci.yml", content: "name: ci\n" }] });
    const r = await env.call("POST", "/v1/onboarding/pr", wf);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(env.gh.of("POST", /access_tokens$/).at(-1)!.body.permissions).toEqual({ contents: "write", pull_requests: "write", workflows: "write", metadata: "read" });
    delete env.gh.appPermissions.workflows;
    const denied = await env.call("POST", "/v1/onboarding/pr", { ...wf, branch: "gantry/onboarding-wf2" });
    expect(denied.status).toBe(502);
    expect(denied.body.code).toBe("token");
  });

  it("refuses without writing when the API fence says the repo is stopped", async () => {
    env.api.onboardingFence = () => ({ allow: false, code: "stopped", reason: "Killed at project scope: incident" });
    const r = await env.call("POST", "/v1/onboarding/pr", body());
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "fenced", fence: "stopped" });
    expect(env.gh.writes()).toEqual([]);
  });

  it("refuses unsafe paths and unknown fields", async () => {
    expect((await env.call("POST", "/v1/onboarding/pr", body({ files: [{ path: "../x", content: "" }] }))).status).toBe(422);
    expect((await env.call("POST", "/v1/onboarding/pr", body({ files: [{ path: ".git/config", content: "" }] }))).status).toBe(422);
    expect((await env.call("POST", "/v1/onboarding/pr", { ...body(), extra: 1 })).status).toBe(422);
  });

  it("says there is nothing to add when every file already matches the default branch", async () => {
    const r = await env.call("POST", "/v1/onboarding/pr", body({ files: [{ path: "README.md", content: "hello\n" }] }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("nothing_to_add");
  });
});

describe("POST /v1/onboarding/merge", () => {
  it("merges at the approved head and refuses a moved head", async () => {
    const o = await env.call("POST", "/v1/onboarding/pr", { repo: REPO, branch: "gantry/onboarding", title: "t", body: "b", files: [{ path: "AGENTS.md", content: "x\n" }] });
    const moved = await env.call("POST", "/v1/onboarding/merge", { repo: REPO, number: o.body.number, headSha: "b".repeat(40) });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("head_moved");
    const ok = await env.call("POST", "/v1/onboarding/merge", { repo: REPO, number: o.body.number, headSha: o.body.headSha, method: "squash" });
    expect(ok.body).toMatchObject({ ok: true, merged: true, alreadyMerged: false });
    const again = await env.call("POST", "/v1/onboarding/merge", { repo: REPO, number: o.body.number, headSha: o.body.headSha });
    expect(again.body).toMatchObject({ merged: true, alreadyMerged: true });
    expect(env.gh.of("PUT", /merge$/)).toHaveLength(1);
  });

  it("is fenced by the API and does not call GitHub when refused", async () => {
    env.api.onboardingFence = () => ({ allow: false, code: "stopped", reason: "halted" });
    const r = await env.call("POST", "/v1/onboarding/merge", { repo: REPO, number: 1, headSha: "a".repeat(40) });
    expect(r.status).toBe(409);
    expect(env.gh.of("PUT", /merge$/)).toHaveLength(0);
  });
});

describe("POST /v1/onboarding/canary", () => {
  it("publishes a canary branch, opens and closes a draft pull request, sees CI, and watches the direct push be rejected", async () => {
    env.gh.protectedRefs.add("refs/heads/main");
    env.gh.ciOnPush = { name: "ci/test", conclusion: "success" };
    const r = await env.call("POST", "/v1/onboarding/canary", { repo: REPO, waitMs: 0, pollMs: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ published: true, draftOpened: true, closed: true, cleaned: true, directPush: "rejected", error: null });
    expect(r.body.checks).toEqual([{ name: "ci/test", status: "completed", conclusion: "success", app: "github-actions" }]);
    expect(env.gh.pulls[0]).toMatchObject({ draft: true, state: "closed" });
    expect([...env.gh.refs.keys()].filter((k) => k.includes("canary"))).toEqual([]);
    expect(env.gh.refs.get("refs/heads/main")).toBe(head);
    expect(env.gh.of("PUT", /merge$/)).toHaveLength(0);
  });

  it("reports an accepted direct push, which is an empty commit and so changes nothing", async () => {
    const r = await env.call("POST", "/v1/onboarding/canary", { repo: REPO, waitMs: 0 });
    expect(r.body.directPush).toBe("accepted");
    const tip = env.gh.refs.get("refs/heads/main")!;
    expect(env.gh.commits.get(tip)!.tree).toBe(env.gh.commits.get(head)!.tree);
    env.gh.refs.set("refs/heads/main", head);
  });

  it("reports no check when CI stays silent for the whole wait", async () => {
    env.gh.protectedRefs.add("refs/heads/main");
    const r = await env.call("POST", "/v1/onboarding/canary", { repo: REPO, waitMs: 30, pollMs: 10 });
    expect(r.body.checks).toEqual([]);
    expect(r.body.closed).toBe(true);
  });

  it("is refused by the fence without touching GitHub", async () => {
    env.api.onboardingFence = () => ({ allow: false, code: "stopped", reason: "killed" });
    const r = await env.call("POST", "/v1/onboarding/canary", { repo: REPO, waitMs: 0 });
    expect(r.status).toBe(409);
    expect(env.gh.writes()).toEqual([]);
  });
});

describe("GET /v1/installation/repos", () => {
  it("lists what the installation can see with a metadata-only token", async () => {
    env.gh.installedRepos.push({ full_name: "acme/ledger", language: "Go", private: true, archived: false, default_branch: "main" });
    const r = await env.call("GET", "/v1/installation/repos");
    expect(r.body.repos).toEqual([{ repo: "acme/ledger", language: "Go", private: true, archived: false, defaultBranch: "main", installationId: 77 }]);
    expect(env.gh.of("POST", /access_tokens$/).at(-1)!.body).toEqual({ permissions: { metadata: "read" } });
  });
});
