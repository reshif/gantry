import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDiff, capText, PATCH_CAP_BYTES } from "../src/areas/workorders/patches.js";
import { TEST_URL, startApp, type TestApp } from "./helpers.js";
import { world } from "./flow-helpers.js";

const FAKE = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const P1 = [
  "diff --git a/src/a.ts b/src/a.ts", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/src/a.ts", "@@ -0,0 +1,3 @@",
  "+const a = 1;", `+const token = "${FAKE}";`, "+export { a };",
  "diff --git a/img.png b/img.png", "new file mode 100644", "index 0000000..2222222", "Binary files /dev/null and b/img.png differ",
  "diff --git a/src/b.ts b/src/b.ts", "index 3333333..4444444 100644", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1,3 +1,3 @@ function b", " keep", "--- not a header, a removed line", "+new", " tail", "",
].join("\n");
const P2 = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..5555555 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " const a = 1;", "-export { a };", "+export default a;", " //", ""].join("\n");

const d = TEST_URL ? describe : describe.skip;

describe("diff parser", () => {
  it("parses files, hunks, line numbers and binary files", () => {
    const f = parseDiff(P1);
    expect(f.map((x) => [x.path, x.status, x.binary])).toEqual([["src/a.ts", "added", false], ["img.png", "added", true], ["src/b.ts", "modified", false]]);
    expect(f[0]!.hunks[0]!.lines[0]).toEqual({ kind: "add", old: null, new: 1, text: "const a = 1;" });
    expect(f[2]).toMatchObject({ plus: 1, minus: 1 });
    expect(f[2]!.hunks[0]!.lines.map((l) => l.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(f[2]!.hunks[0]!.lines[1]).toMatchObject({ old: 2, text: "-- not a header, a removed line" });
  });
  it("cuts on a line boundary", () => {
    expect(capText("aaa\nbbb\nccc\n", 9)).toEqual({ text: "aaa\nbbb\n", truncated: true });
  });
});

d("work order patches: the stored diff as files and hunks", () => {
  let t: TestApp;
  let wo: string;
  let n = 0;
  const w = world(() => t);
  const get = (who: string, url: string) => w.call(who, "GET", url);
  const store = async (id: string, commit: string, text: string | null, at: string, hash = sha(text ?? id)) => {
    await t.db.admin.query(`insert into commits (org_id, id, repo_id, sha, wo_id, message, committed_at) values ($1,$2,'payments-api',$3,$4,'m',$5)`, [t.orgId, `c-${id}`, commit, wo, at]);
    if (text !== null) await t.db.admin.query(`insert into github_blobs (org_id, hash, kind, content, size_bytes) values ($1,$2,'patch',$3,$4) on conflict do nothing`, [t.orgId, hash, Buffer.from(text), Buffer.byteLength(text)]);
    await t.db.admin.query(`insert into patches (org_id, id, wo_id, commit_id, content_hash, size_bytes) values ($1,$2,$3,$4,$5,$6)`, [t.orgId, id, wo, `c-${id}`, hash, Buffer.byteLength(text ?? "")]);
  };
  beforeAll(async () => {
    t = await startApp();
    wo = (await w.submit("p-tomas", { title: `Patches ${++n}` })).body.id as string;
    await store("pt-1", "1".repeat(12), P1, "2026-01-01T00:00:00Z");
    await store("pt-2", "2".repeat(12), P2, "2026-01-02T00:00:00Z");
    await store("pt-big", "3".repeat(12), "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1 +1,40000 @@\n x\n" + "+0123456789abcdef\n".repeat(39999), "2026-01-03T00:00:00Z");
    await store("pt-gone", "4".repeat(12), null, "2026-01-04T00:00:00Z", "f".repeat(64));
  }, 120000);
  afterAll(() => t.close());

  it("returns the hunks of a patch, redacts a planted token, marks a binary file with no content", async () => {
    const r = await get("p-asha", `/api/v1/work-orders/${wo}/patches/pt-1`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "pt-1", commit: "1".repeat(12), truncated: false, redactions: 1, fileCount: 3 });
    expect(JSON.stringify(r.body)).not.toContain(FAKE);
    expect(r.body.files[0].hunks[0].lines[1].text).toContain("[REDACTED:github-token]");
    const bin = r.body.files.find((f: any) => f.path === "img.png");
    expect(bin).toMatchObject({ binary: true, hunks: [] });
  });

  it("filters by path", async () => {
    const r = await get("p-asha", `/api/v1/work-orders/${wo}/patches/pt-1?path=src/b.ts`);
    expect(r.body.files.map((f: any) => f.path)).toEqual(["src/b.ts"]);
    expect(r.body.fileCount).toBe(3);
  });

  it("truncates a huge patch and says so", async () => {
    const r = await get("p-asha", `/api/v1/work-orders/${wo}/patches/pt-big`);
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.bytes).toBeGreaterThan(PATCH_CAP_BYTES);
    expect(r.body.files[0].plus).toBeLessThan(39999);
    expect(r.body.files[0].plus).toBeGreaterThan(1000);
  });

  it("a missing stored object is a 404 with the reason, an unknown patch id too", async () => {
    const r = await get("p-asha", `/api/v1/work-orders/${wo}/patches/pt-gone`);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toMatch(/no longer available/);
    expect((await get("p-asha", `/api/v1/work-orders/${wo}/patches/nope`)).status).toBe(404);
  });

  it("is hidden from a person who cannot see the project", async () => {
    expect((await get("p-diego", `/api/v1/work-orders/${wo}/patches/pt-1`)).status).toBe(404);
    expect((await get("p-diego", `/api/v1/work-orders/${wo}/diff`)).status).toBe(404);
  });

  it("the work-order diff has one entry per path across commits, redacted, with missing patches listed", async () => {
    const r = await get("p-asha", `/api/v1/work-orders/${wo}/diff`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(FAKE);
    expect(r.body.missingPatches).toEqual(["pt-gone"]);
    const a = r.body.files.find((f: any) => f.path === "src/a.ts");
    expect(r.body.files.filter((f: any) => f.path === "src/a.ts").length).toBe(1);
    expect(a).toMatchObject({ status: "added", approximate: true, plus: 4, minus: 1 });
    expect(a.commits.map((c: any) => c.commit)).toEqual(["1".repeat(12), "2".repeat(12)]);
    const one = await get("p-asha", `/api/v1/work-orders/${wo}/diff?path=src/b.ts`);
    expect(one.body.files).toHaveLength(1);
    expect(one.body.files[0]).toMatchObject({ path: "src/b.ts", approximate: false });
  });
});
