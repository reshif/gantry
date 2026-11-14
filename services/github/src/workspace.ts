/**
 * Workspace volumes (spec 4.3 step 2, 4.3 step 7, 5.2). DECISION: the broker talks to the Docker API itself, but only to create a short-lived,
 * never-started helper container that mounts one `ws-<id>` volume, and only through the two archive endpoints:
 *   seed  : PUT  /containers/{helper}/archive  (the clone is built in broker scratch space and streamed in, owned by the runner's uid/gid 10001)
 *   read  : GET  /containers/{helper}/archive  (a read-only mount; only git object data is copied out, as plain files)
 * Nothing is ever started or executed in the helper or in the workspace: the helper has no network, no capabilities, a read-only root and exists only
 * so Docker will serve archive calls for the volume. The helper is created from the broker's own image and removed in `finally`.
 * Cost: the broker needs the Docker socket (compose: a socket mount and `group_add`). That is root-equivalent on the host, so the call surface is
 * kept to volume inspect, container create/remove and the archive endpoints, and the volume must be one the launcher created (name `ws-...`, label
 * `gantry.managed-by=gantry-launcher`). The alternative, a seed/read endpoint on the launcher, keeps the socket in one place and is the cleaner
 * long-term shape; `WorkspaceStore` is the seam for it.
 */
import type Docker from "dockerode";
import type { Readable } from "node:stream";
import { tarDirectory, extractTar } from "./tar.js";
import { BrokerError } from "./errors.js";

export interface WorkspaceStore {
  /** Writes the directory tree into the volume's root, owned by uid:gid. */
  seed(volume: string, srcDir: string, o: { uid: number; gid: number }): Promise<void>;
  /** Copies the workspace's git object data (never config, hooks or the working tree) into `destGitDir`, a bare repository the broker created. */
  copyGitData(volume: string, destGitDir: string, o: { maxBytes: number }): Promise<{ files: number; bytes: number }>;
}

export const VOLUME_NAME = /^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const MANAGED_BY = "gantry-launcher";
/** Go's os.ModeSymlink, as Docker reports it in the path stat. */
const MODE_SYMLINK = 0x08000000;
/** What of `.git` the publisher reads. `objects/info` (alternates) is deliberately not among them. */
const GIT_PARTS = ["objects", "refs", "HEAD", "packed-refs", "shallow"] as const;

export class DockerWorkspaceStore implements WorkspaceStore {
  constructor(private readonly docker: Docker, private readonly helperImage: string) {}

  private async assertVolume(volume: string): Promise<void> {
    if (!VOLUME_NAME.test(volume)) throw new BrokerError(422, "bad_volume", "The volume name must be a launcher workspace volume (ws-<id>).");
    let info: { Labels?: Record<string, string> | null };
    try {
      info = (await this.docker.getVolume(volume).inspect()) as typeof info;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) throw new BrokerError(404, "volume_missing", `Volume ${volume} does not exist.`);
      throw new BrokerError(502, "docker", `Docker could not inspect the volume: ${(e as Error).message}`);
    }
    if (info.Labels?.["gantry.managed-by"] !== MANAGED_BY) throw new BrokerError(422, "bad_volume", `Volume ${volume} was not created by the launcher.`);
  }

  private async withHelper<T>(volume: string, readOnly: boolean, fn: (c: Docker.Container) => Promise<T>): Promise<T> {
    await this.assertVolume(volume);
    const c = await this.docker.createContainer({
      Image: this.helperImage, Entrypoint: ["/bin/true"], Cmd: [], User: "10001:10001", NetworkDisabled: true, Labels: { "gantry.managed-by": "gantry-github", "gantry.purpose": "workspace-helper" },
      HostConfig: { Binds: [`${volume}:/workspace${readOnly ? ":ro" : ""}`], NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 64 * 1024 * 1024, PidsLimit: 16, AutoRemove: false },
    });
    try {
      return await fn(c);
    } finally {
      await c.remove({ force: true, v: false }).catch(() => undefined);
    }
  }

  async seed(volume: string, srcDir: string, o: { uid: number; gid: number }): Promise<void> {
    await this.withHelper(volume, false, async (c) => {
      await c.putArchive(tarDirectory(srcDir, o) as unknown as NodeJS.ReadableStream, { path: "/workspace" });
    });
  }

  /**
   * Docker resolves every path component of an archive request inside the helper's own root, so a workspace whose `.git` (or one of the parts below it) is a
   * symlink would be read from wherever it points: the broker image's filesystem. Docker's path stat does not follow the last component, so each one is checked first.
   */
  private async assertPlain(c: Docker.Container, path: string): Promise<boolean> {
    let stat: { mode?: number; linkTarget?: string } | null = null;
    try {
      const res = (await c.infoArchive({ path })) as unknown as { headers?: Record<string, string | string[] | undefined>; resume?: () => void };
      res.resume?.();
      const h = res.headers?.["x-docker-container-path-stat"];
      if (typeof h === "string") stat = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { mode?: number; linkTarget?: string };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return false;
      throw new BrokerError(502, "docker", `Docker could not stat ${path}: ${(e as Error).message}`);
    }
    if (!stat) throw new BrokerError(502, "docker", `Docker did not describe ${path}.`);
    if (((stat.mode ?? 0) & MODE_SYMLINK) !== 0 || stat.linkTarget) throw new BrokerError(422, "git_symlink", `${path.replace(/^\/workspace\//, "")} in the workspace is a symbolic link; it is not read.`);
    return true;
  }

  async copyGitData(volume: string, destGitDir: string, o: { maxBytes: number }): Promise<{ files: number; bytes: number }> {
    return this.withHelper(volume, true, async (c) => {
      let files = 0, bytes = 0;
      if (!(await this.assertPlain(c, "/workspace/.git"))) throw new BrokerError(422, "no_git_data", "The workspace has no .git.");
      for (const part of GIT_PARTS) {
        if (!(await this.assertPlain(c, `/workspace/.git/${part}`))) {
          if (part !== "objects" && part !== "HEAD") continue;
          throw new BrokerError(422, "no_git_data", `The workspace has no .git/${part}.`);
        }
        let stream: NodeJS.ReadableStream;
        try {
          stream = (await c.getArchive({ path: `/workspace/.git/${part}` })) as NodeJS.ReadableStream;
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode === 404 && part !== "objects" && part !== "HEAD") continue;
          throw new BrokerError(422, "no_git_data", `The workspace has no .git/${part}.`);
        }
        const r = await extractTar(stream as unknown as Readable, destGitDir, {
          maxBytes: o.maxBytes - bytes,
          map: (name) => (name === part || name.startsWith(`${part}/`)) && !name.startsWith("objects/info") ? name : null,
        });
        files += r.files; bytes += r.bytes;
      }
      return { files, bytes };
    });
  }
}
