/**
 * Real Docker check of the workspace store (run with GANTRY_GITHUB_DOCKER_TEST=1; needs the Docker socket and a small image with /bin/true).
 * Uses names prefixed w3gh- and removes everything it creates.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerError } from "../src/errors.js";
import { DockerWorkspaceStore } from "../src/workspace.js";

const d = process.env.GANTRY_GITHUB_DOCKER_TEST ? describe : describe.skip;
const IMAGE = process.env.GANTRY_GITHUB_HELPER_IMAGE ?? "mirror.gcr.io/library/busybox:1.36";
const VOL = "ws-w3gh-test";
const OTHER = "ws-w3gh-unlabelled";

d("DockerWorkspaceStore against real Docker", () => {
  const docker = new Docker();
  const store = new DockerWorkspaceStore(docker, IMAGE);
  beforeAll(async () => {
    await docker.createVolume({ Name: VOL, Labels: { "gantry.managed-by": "gantry-launcher" } });
    await docker.createVolume({ Name: OTHER });
  });
  afterAll(async () => {
    for (const v of [VOL, OTHER]) await docker.getVolume(v).remove({ force: true }).catch(() => undefined);
  });

  const cat = (path: string): string => execFileSync("docker", ["run", "--rm", "--network", "none", "-v", `${VOL}:/w:ro`, IMAGE, "sh", "-c", path], { encoding: "utf8" });

  it("seeds a volume owned by the runner user, and reads only git data back out of it read-only", async () => {
    const src = await mkdtemp(join(tmpdir(), "w3gh-src-"));
    execFileSync("git", ["init", "-q", "-b", "main", src]);
    await writeFile(join(src, "a.txt"), "hello");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", src, "add", "-A"]);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", src, "commit", "-q", "-m", "m"]);
    await store.seed(VOL, src, { uid: 10001, gid: 10001 });
    expect(cat("stat -c '%u:%g' /w/a.txt /w/.git && cat /w/a.txt").trim().split("\n")).toEqual(["10001:10001", "10001:10001", "hello"]);

    const dest = await mkdtemp(join(tmpdir(), "w3gh-dest-"));
    const r = await store.copyGitData(VOL, dest, { maxBytes: 1 << 28 });
    expect(r.files).toBeGreaterThan(3);
    expect(existsSync(join(dest, "HEAD"))).toBe(true);
    expect(existsSync(join(dest, "config"))).toBe(false);
    expect(await readFile(join(dest, "HEAD"), "utf8")).toContain("refs/heads/main");
    // Helpers are gone.
    const left = await docker.listContainers({ all: true, filters: { label: ["gantry.managed-by=gantry-github"] } });
    expect(left).toHaveLength(0);
    await rm(src, { recursive: true }); await rm(dest, { recursive: true });
  });
  it("refuses volumes the launcher did not create, and names that are not workspaces", async () => {
    const src = await mkdtemp(join(tmpdir(), "w3gh-src2-"));
    await mkdir(src, { recursive: true });
    await expect(store.seed(OTHER, src, { uid: 1, gid: 1 })).rejects.toMatchObject({ code: "bad_volume" });
    await expect(store.seed("pgdata", src, { uid: 1, gid: 1 })).rejects.toBeInstanceOf(BrokerError);
    await expect(store.seed("ws-w3gh-missing", src, { uid: 1, gid: 1 })).rejects.toMatchObject({ code: "volume_missing" });
    await rm(src, { recursive: true });
  });
});
