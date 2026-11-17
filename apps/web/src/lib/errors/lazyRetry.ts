/**
 * lazy() that survives a stale deploy. After a release the old chunk names 404; the first failure is retried once, and if the
 * chunk is still missing the page reloads once (guarded by a sessionStorage stamp so it can never loop) to pick up the new
 * index.html. A second failure inside the guard window throws, and the route error boundary offers Retry / Reload.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export const CHUNK_RELOAD_KEY = "gantry.chunk-reload";
const GUARD_MS = 60_000;

export interface LazyRetryDeps {
  reload?: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

function defaultStorage(): LazyRetryDeps["storage"] {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export async function loadWithRetry<T>(factory: () => Promise<T>, deps: LazyRetryDeps = {}): Promise<T> {
  const wait = deps.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const store = deps.storage === undefined ? defaultStorage() : deps.storage;
  const reload = deps.reload ?? (() => window.location.reload());
  try {
    const mod = await factory();
    try {
      store?.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      /* ignore */
    }
    return mod;
  } catch (first) {
    await wait(400);
    try {
      return await factory();
    } catch (err) {
      let last = 0;
      try {
        last = Number(store?.getItem(CHUNK_RELOAD_KEY) ?? 0) || 0;
      } catch {
        /* ignore */
      }
      if (now() - last > GUARD_MS && store) {
        try {
          store.setItem(CHUNK_RELOAD_KEY, String(now()));
        } catch {
          throw err ?? first;
        }
        reload();
        return new Promise<T>(() => undefined); // the page is going away; keep Suspense showing the skeleton
      }
      throw err ?? first;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>): LazyExoticComponent<T> {
  return lazy(() => loadWithRetry(factory));
}
