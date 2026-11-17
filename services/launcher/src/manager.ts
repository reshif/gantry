import type Dockerode from "dockerode";
import type { ContainerInspectInfo, NetworkInspectInfo } from "dockerode";
import { firstFreeBlock, formatCidr, parseCidr, type Cidr } from "./cidr.js";
import type { LauncherConfig } from "./config.js";
import { err, ok, type Result } from "./result.js";
import { LABEL_MANAGED, LABEL_RUN, LABEL_VARIANT, LABEL_WORKSPACE, MANAGED_BY, names, networkOptions, createRequest, runLabels, runnerContainerOptions, type StartRunInput } from "./template.js";

export type LauncherError =
  | { kind: "capacity"; msg: string }
  | { kind: "subnet_exhausted"; msg: string }
  | { kind: "image_missing"; msg: string }
  | { kind: "edge_missing"; msg: string }
  | { kind: "conflict"; msg: string }
  | { kind: "teardown_incomplete"; msg: string; stop: StopOutcome }
  | { kind: "docker"; msg: string };

export type StartOutcome = {
  runId: string;
  /** prepared: network and volume exist, no runner yet. started: runner created and started. running: it already was. */
  state: "prepared" | "started" | "running";
  container?: string;
  network: string;
  subnet?: string;
  volume: string;
};

export type StopOutcome = {
  runId: string;
  found: boolean;
  container: "removed" | "absent" | "failed";
  network: "removed" | "absent" | "failed";
  volume: "removed" | "kept" | "absent" | "failed";
  errors: string[];
};

export interface RunInventoryEntry {
  runId: string;
  variant?: string;
  workspaceRef?: string;
  container: { id: string; name: string; state: string; status: string; image: string; createdAt: number } | null;
  network: { id: string; name: string; subnet?: string; attached: string[] } | null;
  volume: { name: string; createdAt?: string } | null;
}

export interface RunInventory {
  runs: RunInventoryEntry[];
  capacity: { max: number; networks: number };
}

const statusOf = (e: unknown): number | undefined => (typeof e === "object" && e !== null ? (e as { statusCode?: number }).statusCode : undefined);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialises async sections (subnet allocation needs list-then-create to be atomic within this process). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class RunManager {
  private readonly netLock = new Mutex();
  /** Per-run lock so a start and a stop of the same run never interleave. */
  private readonly runLocks = new Map<string, Mutex>();

  constructor(
    private readonly docker: Dockerode,
    private readonly cfg: LauncherConfig,
  ) {}

  private lockFor(id: string): Mutex {
    let m = this.runLocks.get(id);
    if (!m) {
      m = new Mutex();
      this.runLocks.set(id, m);
    }
    return m;
  }

  private async withRunLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const m = this.lockFor(id);
    try {
      return await m.run(fn);
    } finally {
      // drop idle locks so the map does not grow with every run id ever seen
      this.runLocks.delete(id);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  // ---- start-run -------------------------------------------------------------------------------------------

  start(input: StartRunInput): Promise<Result<StartOutcome, LauncherError>> {
    return this.withRunLock(input.runId, async () => {
      try {
        return await this.startLocked(input);
      } catch (e) {
        return err({ kind: "docker", msg: messageOf(e) } as LauncherError);
      }
    });
  }

  private async startLocked(input: StartRunInput): Promise<Result<StartOutcome, LauncherError>> {
    const id = input.runId;
    const cname = names.container(id);

    const existing = await this.inspectContainer(cname);
    if (existing) {
      if (existing.Config.Labels?.[LABEL_RUN] !== id) return err({ kind: "conflict", msg: `container ${cname} exists and is not a launcher run` });
      if (existing.State.Running) {
        return ok({ runId: id, state: "running", container: cname, network: names.network(id), volume: names.volume(id) });
      }
      return err({ kind: "conflict", msg: `run ${id} has a stopped container; stop-run it before starting again` });
    }

    const startNow = input.seedComplete !== false;
    const vol = await this.ensureVolume(input);
    if (!vol.ok) return vol;
    const net = await this.ensureNetwork(input);
    if (!net.ok) {
      if (vol.value.created) await this.removeVolumeQuiet(names.volume(id));
      return net;
    }
    const base: StartOutcome = { runId: id, state: "prepared", network: names.network(id), volume: names.volume(id) };
    if (net.value.subnet) base.subnet = net.value.subnet;
    if (!startNow) return ok(base);

    const rollback = async () => {
      await this.removeContainerQuiet(cname);
      await this.detachAll(names.network(id));
      if (net.value.created) await this.removeNetworkQuiet(names.network(id));
      if (vol.value.created) await this.removeVolumeQuiet(names.volume(id));
    };

    const image = this.cfg.variants.get(input.variant) as string;
    try {
      await this.docker.getImage(image).inspect();
    } catch (e) {
      await rollback();
      return statusOf(e) === 404
        ? err({ kind: "image_missing", msg: `runner image ${image} is not present on this host` })
        : err({ kind: "docker", msg: messageOf(e) });
    }

    const edge = await this.findEdge();
    if (!edge) {
      await rollback();
      return err({ kind: "edge_missing", msg: "gantry-edge container not found or not running" });
    }

    try {
      const container = await this.docker.createContainer(createRequest(runnerContainerOptions(this.cfg, input)));
      await this.attachEdge(names.network(id), edge);
      await container.start();
    } catch (e) {
      await rollback();
      return err({ kind: "docker", msg: messageOf(e) });
    }
    return ok({ ...base, state: "started", container: cname });
  }

  private async findEdge(): Promise<string | undefined> {
    const e = this.cfg.edge;
    if (e.container) {
      const info = await this.inspectContainer(e.container);
      return info?.State.Running ? info.Id : undefined;
    }
    const label = [`com.docker.compose.service=${e.composeService}`];
    if (e.composeProject) label.push(`com.docker.compose.project=${e.composeProject}`);
    const list = await this.docker.listContainers({ filters: { label, status: ["running"] } });
    return list[0]?.Id;
  }

  private async attachEdge(network: string, edgeId: string): Promise<void> {
    const info = await this.docker.getNetwork(network).inspect();
    if (info.Containers && edgeId in info.Containers) return;
    await this.docker.getNetwork(network).connect({ Container: edgeId, EndpointConfig: { Aliases: [this.cfg.edge.alias] } });
  }

  private async ensureVolume(input: StartRunInput): Promise<Result<{ created: boolean }, LauncherError>> {
    const name = names.volume(input.runId);
    try {
      const info = await this.docker.getVolume(name).inspect();
      if (info.Labels?.[LABEL_RUN] !== input.runId) return err({ kind: "conflict", msg: `volume ${name} exists and is not a launcher run volume` });
      return ok({ created: false });
    } catch (e) {
      if (statusOf(e) !== 404) return err({ kind: "docker", msg: messageOf(e) });
    }
    try {
      await this.docker.createVolume({ Name: name, Driver: "local", Labels: runLabels(input) });
      return ok({ created: true });
    } catch (e) {
      return err({ kind: "docker", msg: messageOf(e) });
    }
  }

  private async ensureNetwork(input: StartRunInput): Promise<Result<{ created: boolean; subnet?: string }, LauncherError>> {
    const name = names.network(input.runId);
    return this.netLock.run(async () => {
      try {
        const info = await this.docker.getNetwork(name).inspect();
        if (info.Labels?.[LABEL_RUN] !== input.runId) return err({ kind: "conflict", msg: `network ${name} exists and is not a launcher run network` } as LauncherError);
        const subnet = info.IPAM?.Config?.[0]?.Subnet;
        return ok(subnet ? { created: false, subnet } : { created: false });
      } catch (e) {
        if (statusOf(e) !== 404) return err({ kind: "docker", msg: messageOf(e) } as LauncherError);
      }

      const all = await this.docker.listNetworks();
      const mine = all.filter((n) => n.Labels?.[LABEL_MANAGED] === MANAGED_BY).length;
      if (mine >= this.cfg.maxConcurrentRuns) {
        return err({ kind: "capacity", msg: `at the concurrent run limit (${this.cfg.maxConcurrentRuns})` } as LauncherError);
      }
      const used: Cidr[] = [];
      for (const n of all) for (const c of n.IPAM?.Config ?? []) {
        const p = c.Subnet ? parseCidr(c.Subnet, { align: true }) : undefined;
        if (p) used.push(p);
      }

      const skip = new Set<string>();
      for (let attempt = 0; attempt < 8; attempt++) {
        const block = firstFreeBlock(this.cfg.pool, this.cfg.subnetPrefix, used, skip);
        if (!block) return err({ kind: "subnet_exhausted", msg: "no free run subnet in the pool" } as LauncherError);
        const subnet = formatCidr(block);
        try {
          await this.docker.createNetwork(networkOptions(this.cfg, input, subnet));
          return ok({ created: true, subnet });
        } catch (e) {
          // Another network took the range (a race with something outside this process): skip it and try the next block.
          if (/overlap|pool/i.test(messageOf(e))) {
            skip.add(subnet);
            continue;
          }
          return err({ kind: "docker", msg: messageOf(e) } as LauncherError);
        }
      }
      return err({ kind: "subnet_exhausted", msg: "could not allocate a run subnet after retries" } as LauncherError);
    });
  }

  // ---- stop-run --------------------------------------------------------------------------------------------

  stop(id: string, opts: { keepWorkspace: boolean }): Promise<Result<StopOutcome, LauncherError>> {
    return this.withRunLock(id, async () => {
      const out: StopOutcome = { runId: id, found: false, container: "absent", network: "absent", volume: "absent", errors: [] };
      const note = (what: string, e: unknown) => out.errors.push(`${what}: ${messageOf(e)}`);

      // 1. container: SIGTERM, grace, SIGKILL (docker stop), then remove.
      const cname = names.container(id);
      const c = await this.inspectContainer(cname).catch((e) => (note("inspect container", e), undefined));
      if (c) {
        if (c.Config.Labels?.[LABEL_RUN] !== id) return err({ kind: "conflict", msg: `container ${cname} is not a launcher run` });
        out.found = true;
        try {
          if (c.State.Running || c.State.Paused || c.State.Restarting) {
            try {
              await this.docker.getContainer(c.Id).stop({ t: this.cfg.limits.stopGraceSeconds });
            } catch (e) {
              if (statusOf(e) !== 304 && statusOf(e) !== 404) throw e;
            }
            const after = await this.inspectContainer(cname);
            if (after?.State.Running) await this.docker.getContainer(c.Id).kill({ signal: "SIGKILL" }).catch((e) => note("kill", e));
          }
          await this.docker.getContainer(c.Id).remove({ force: true, v: true }).catch((e) => {
            if (statusOf(e) !== 404) throw e;
          });
          out.container = (await this.inspectContainer(cname)) ? "failed" : "removed";
        } catch (e) {
          out.container = "failed";
          note("container", e);
        }
      }

      // 2. network: disconnect whatever is still attached (the edge), then remove.
      if (out.container !== "failed") {
        const nname = names.network(id);
        try {
          const info = await this.inspectNetwork(nname);
          if (info) {
            if (info.Labels?.[LABEL_RUN] !== id) return err({ kind: "conflict", msg: `network ${nname} is not a launcher run network` });
            out.found = true;
            await this.detachAll(nname, info);
            await this.removeNetworkRetry(nname);
            out.network = (await this.inspectNetwork(nname)) ? "failed" : "removed";
          }
        } catch (e) {
          out.network = "failed";
          note("network", e);
        }
      } else {
        out.network = "failed";
        out.errors.push("network: not attempted because the container is still present");
      }

      // 3. volume: only on request; otherwise it is kept for publishing.
      const vname = names.volume(id);
      try {
        const v = await this.docker.getVolume(vname).inspect().catch((e) => {
          if (statusOf(e) === 404) return undefined;
          throw e;
        });
        if (v) {
          if (v.Labels?.[LABEL_RUN] !== id) return err({ kind: "conflict", msg: `volume ${vname} is not a launcher run volume` });
          out.found = true;
          if (opts.keepWorkspace) out.volume = "kept";
          else if (out.container === "failed") {
            out.volume = "failed";
            out.errors.push("volume: not attempted because the container is still present");
          } else {
            await this.removeVolumeRetry(vname);
            out.volume = "removed";
          }
        }
      } catch (e) {
        out.volume = "failed";
        note("volume", e);
      }

      if (out.errors.length > 0) return err({ kind: "teardown_incomplete", msg: out.errors.join("; "), stop: out });
      return ok(out);
    });
  }

  // ---- list-runs -------------------------------------------------------------------------------------------

  async list(): Promise<Result<RunInventory, LauncherError>> {
    try {
      const filters = { label: [`${LABEL_MANAGED}=${MANAGED_BY}`] };
      const [containers, networks, volumes] = await Promise.all([
        this.docker.listContainers({ all: true, filters }),
        this.docker.listNetworks({ filters }),
        this.docker.listVolumes({ filters }),
      ]);
      const runs = new Map<string, RunInventoryEntry>();
      const entry = (id: string, labels: Record<string, string> | null | undefined): RunInventoryEntry => {
        let e = runs.get(id);
        if (!e) {
          e = { runId: id, container: null, network: null, volume: null };
          runs.set(id, e);
        }
        const v = labels?.[LABEL_VARIANT];
        const w = labels?.[LABEL_WORKSPACE];
        if (v !== undefined) e.variant = v;
        if (w !== undefined) e.workspaceRef = w;
        return e;
      };
      for (const c of containers) {
        const id = c.Labels[LABEL_RUN];
        if (!id) continue;
        entry(id, c.Labels).container = { id: c.Id, name: (c.Names[0] ?? "").replace(/^\//, ""), state: c.State, status: c.Status, image: c.Image, createdAt: c.Created };
      }
      for (const n of networks) {
        const id = n.Labels?.[LABEL_RUN];
        if (!id) continue;
        const info = await this.inspectNetwork(n.Name);
        const attached = Object.values(info?.Containers ?? {}).map((x) => x.Name);
        const subnet = n.IPAM?.Config?.[0]?.Subnet;
        entry(id, n.Labels).network = subnet ? { id: n.Id, name: n.Name, subnet, attached } : { id: n.Id, name: n.Name, attached };
      }
      for (const v of volumes.Volumes ?? []) {
        const id = v.Labels?.[LABEL_RUN];
        if (!id) continue;
        const createdAt = (v as { CreatedAt?: string }).CreatedAt;
        entry(id, v.Labels).volume = createdAt ? { name: v.Name, createdAt } : { name: v.Name };
      }
      return ok({
        runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
        capacity: { max: this.cfg.maxConcurrentRuns, networks: networks.length },
      });
    } catch (e) {
      return err({ kind: "docker", msg: messageOf(e) });
    }
  }

  // ---- docker helpers --------------------------------------------------------------------------------------

  private async inspectContainer(name: string): Promise<ContainerInspectInfo | undefined> {
    try {
      return await this.docker.getContainer(name).inspect();
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
  }

  private async inspectNetwork(name: string): Promise<NetworkInspectInfo | undefined> {
    try {
      return await this.docker.getNetwork(name).inspect();
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
  }

  private async detachAll(network: string, known?: NetworkInspectInfo): Promise<void> {
    const info = known ?? (await this.inspectNetwork(network));
    for (const cid of Object.keys(info?.Containers ?? {})) {
      await this.docker.getNetwork(network).disconnect({ Container: cid, Force: true }).catch((e) => {
        if (statusOf(e) !== 404 && statusOf(e) !== 403) throw e;
      });
    }
  }

  private async removeNetworkRetry(name: string): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await this.docker.getNetwork(name).remove();
        return;
      } catch (e) {
        if (statusOf(e) === 404) return;
        last = e;
        await sleep(200 * (i + 1));
      }
    }
    throw last;
  }

  private async removeVolumeRetry(name: string): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await this.docker.getVolume(name).remove();
        return;
      } catch (e) {
        if (statusOf(e) === 404) return;
        last = e;
        await sleep(200 * (i + 1));
      }
    }
    throw last;
  }

  private async removeContainerQuiet(name: string): Promise<void> {
    await this.docker.getContainer(name).remove({ force: true, v: true }).catch(() => undefined);
  }
  private async removeNetworkQuiet(name: string): Promise<void> {
    await this.removeNetworkRetry(name).catch(() => undefined);
  }
  private async removeVolumeQuiet(name: string): Promise<void> {
    await this.removeVolumeRetry(name).catch(() => undefined);
  }
}
