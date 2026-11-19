import { execFile } from "node:child_process";

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

export function workspaceMessage(maxBytes: number, usedBytes: number): string {
  const gb = (n: number) => (n / 2 ** 30).toFixed(1);
  return `workspace over ${gb(maxBytes)} GB (${gb(usedBytes)} GB used): the run was stopped; keep generated files, caches and build output small or out of /workspace`;
}

/**
 * Starts the periodic check. `onOver` is called once, when usage passes `maxBytes`. Never overlaps itself. Returns a stop function.
 */
export function watchWorkspace(opts: { dir: string; maxBytes: number; intervalMs?: number; measure?: (dir: string) => Promise<number>; onOver: (usedBytes: number) => void }): () => void {
  const measure = opts.measure ?? duBytes;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const used = await measure(opts.dir);
      if (!stopped && used > opts.maxBytes) {
        stopped = true;
        opts.onOver(used);
      }
    } catch {
      /* a failed measurement is not a breach; the next tick tries again */
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
