import { execFile } from "node:child_process";
import { readdir, readlink, stat } from "node:fs/promises";

/**
 * The per-run workspace cap, wrapper side (S-90). The launcher can make the cap hard with a size-limited volume (WORKSPACE_BACKING=tmpfs); on a
 * plain disk volume (the default: a tmpfs workspace is paid for in RAM) this is the guard: the wrapper measures /workspace every few seconds and stops
 * the run with a clear failure when it is over the cap. The wrapper is PID 1 and a tool process cannot signal it, so the run cannot switch this off.
 */
export const WORKSPACE_CHECK_MS = 5_000;

/** Disk blocks in use under `dir`, in bytes (`du -sk`: sparse files count what they take, not what they claim). */
export function duBytes(dir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("du", ["-sk", "-x", dir], { timeout: 60_000, maxBuffer: 1 << 16 }, (e, out) => {
      // du exits non-zero on an unreadable entry but still prints a total: use it
      const kb = Number.parseInt(String(out).split(/\s/)[0] ?? "", 10);
      if (Number.isFinite(kb)) resolve(kb * 1024);
      else reject(e ?? new Error("du printed no size"));
    });
  });
}

/**
 * Disk held by files that were unlinked while still open (G-S7): `du` cannot see them, the kernel keeps their blocks until the last descriptor closes,
 * and any tool command can do this. The wrapper is PID 1 and sees /proc: every open fd whose target lies under `dir`, including "(deleted)" ones,
 * counted once per inode by st_blocks.
 */
export async function openDeletedBytes(dir: string, proc = "/proc"): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  let pids: string[] = [];
  try {
    pids = (await readdir(proc)).filter((p) => /^\d+$/.test(p));
  } catch {
    return 0;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await readdir(`${proc}/${pid}/fd`);
    } catch {
      continue; // gone, or not ours to read
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`${proc}/${pid}/fd/${fd}`);
        if (!target.endsWith(" (deleted)")) continue;
        const path = target.slice(0, -" (deleted)".length);
        if (path !== dir && !path.startsWith(dir.endsWith("/") ? dir : `${dir}/`)) continue;
        const st = await stat(`${proc}/${pid}/fd/${fd}`);
        if (!st.isFile()) continue;
        const key = `${st.dev}:${st.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += st.blocks * 512;
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return total;
}

/** What the workspace holds on disk: files in the tree plus deleted-but-open ones. */
export async function workspaceBytes(dir: string): Promise<number> {
  const [tree, hidden] = await Promise.all([duBytes(dir), openDeletedBytes(dir)]);
  return tree + hidden;
}

export function workspaceMessage(maxBytes: number, usedBytes: number): string {
  const gb = (n: number) => (n / 2 ** 30).toFixed(1);
  return `workspace over ${gb(maxBytes)} GB (${gb(usedBytes)} GB used): the run was stopped; keep generated files, caches and build output small or out of /workspace`;
}

/**
 * Starts the periodic check. `onOver` is called once, when usage passes `maxBytes`. Never overlaps itself. Returns a stop function.
 */
export const MAX_FAILED_MEASUREMENTS = 3;

export function watchWorkspace(opts: { dir: string; maxBytes: number; intervalMs?: number; measure?: (dir: string) => Promise<number>; onOver: (usedBytes: number) => void; onUnmeasurable?: (failures: number) => void }): () => void {
  const measure = opts.measure ?? workspaceBytes;
  let failures = 0;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const used = await measure(opts.dir);
      failures = 0;
      if (!stopped && used > opts.maxBytes) {
        stopped = true;
        opts.onOver(used);
      }
    } catch {
      // A size that cannot be measured is not "no breach": after three failures in a row the run is stopped (G-S7).
      if (++failures >= MAX_FAILED_MEASUREMENTS && !stopped) {
        stopped = true;
        (opts.onUnmeasurable ?? ((n) => opts.onOver(Number.POSITIVE_INFINITY * n)))(failures);
      }
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), opts.intervalMs ?? WORKSPACE_CHECK_MS);
  t.unref();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
