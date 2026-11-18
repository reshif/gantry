/**
 * Connect group kit (Integrations, MCP servers, API and triggers, Notifications): the URL state of tabs, filters, sort and
 * the open drawer (rule F-15, prototype names: tab, q, type, st, sort, dir, page), the prototype drawer anatomy, and the
 * coarse "Nh ago" time the prototype uses in these tables.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Btn, Empty, IconBtn } from "../../ui/primitives";

const EVT = "gantry:urlstate";
const subscribe = (fn: () => void) => {
  window.addEventListener(EVT, fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener(EVT, fn);
    window.removeEventListener("popstate", fn);
  };
};
const snap = (): string => {
  try {
    return window.location.search;
  } catch {
    return "";
  }
};

function writeQuery(patch: Record<string, string | null>): void {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.href);
  } catch {
    /* a sandboxed frame without history access: the screen still works, it is just not in the URL */
  }
  window.dispatchEvent(new Event(EVT));
}

/**
 * URL-held screen state. `defaults` names every key and its default value; a key at its default is kept out of the URL.
 * `set` changes keys together and resets `page` unless it is set in the same call. Keys are removed again when the screen unmounts,
 * so a tab of one screen never leaks into the next.
 */
export function useUrlState<K extends string>(defaults: Record<K, string>): { v: Record<K, string>; set: (patch: Partial<Record<K, string>>) => void; clear: (...keep: K[]) => void } {
  const search = useSyncExternalStore(subscribe, snap, () => "");
  const keys = Object.keys(defaults) as K[];
  const sp = new URLSearchParams(search);
  const v = {} as Record<K, string>;
  for (const k of keys) v[k] = sp.get(k) ?? defaults[k];
  const ref = useRef({ keys, defaults });
  ref.current = { keys, defaults };
  useEffect(
    () => () => {
      const patch: Record<string, null> = {};
      for (const k of ref.current.keys) patch[k] = null;
      writeQuery(patch);
    },
    [],
  );
  const set = (patch: Partial<Record<K, string>>): void => {
    const out: Record<string, string | null> = {};
    for (const [k, val] of Object.entries(patch) as Array<[K, string]>) out[k] = val === defaults[k] ? null : val;
    if ("page" in defaults && !("page" in patch) && Object.keys(patch).some((k) => k !== "open")) out["page"] = null;
    writeQuery(out);
  };
  const clear = (...keep: K[]): void => {
    const out: Record<string, null> = {};
    for (const k of keys) if (!keep.includes(k)) out[k] = null;
    writeQuery(out);
  };
  return { v, set, clear };
}

/** One value of a closed list, or the fallback: a stale or hand-edited URL never leaves a screen on a tab that does not exist. */
export const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T => (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** The prototype's coarse relative time: "just now", "12m ago", "5h ago", "3d ago". */
export function agoShort(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "never";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The prototype drawer anatomy (eyebrow, title, close, body, foot) inside the shared drawer container. */
export function CrDrawer({ eyebrow, title, close, foot, children }: { eyebrow: ReactNode; title: ReactNode; close: () => void; foot?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="drawer-h">
        <div>
          <div className="label">{eyebrow}</div>
          <h2>{title}</h2>
        </div>
        <IconBtn icon="x" label="Close" className="iconbtn" onClick={close} />
      </div>
      <div className="drawer-b">{children}</div>
      {foot ? <div className="drawer-f">{foot}</div> : null}
    </>
  );
}

/** A definition list in the prototype's `kv` layout. */
export function Kv({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, val], i) => (
        <div key={i} style={{ display: "contents" }}><dt>{k}</dt><dd>{val}</dd></div>
      ))}
    </dl>
  );
}

/** Sorted-table URL state: `sort=<key>` and `dir=asc|desc`. */
export const sortFrom = (sort: string, dir: string, fallbackKey: string, fallbackDir: 1 | -1): { key: string; dir: 1 | -1 } => ({ key: sort || fallbackKey, dir: dir ? (dir === "desc" ? -1 : 1) : fallbackDir });

/** Wrap a URL-held drawer: when it unmounts (close button, Escape or a route change) its id leaves the URL again, unless a newer drawer replaced it. */
export function ClearOnClose({ param, id, children }: { param: string; id: string; children: ReactNode }) {
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setTimeout(() => {
        if (alive.current) return;
        try {
          if (new URLSearchParams(window.location.search).get(param) === id) writeQuery({ [param]: null });
        } catch { /* no URL access */ }
      }, 0);
    };
  }, [param, id]);
  return <>{children}</>;
}

/** The shared "nothing matches" state of the filtered lists, with the prototype's Clear filters button. */
export function NothingMatches({ onClear }: { onClear: () => void }) {
  return <Empty icon="search" title="Nothing matches" text="Try clearing a filter or searching for something else." action={<Btn label="Clear filters" id="clear-filters" onClick={onClear} />} />;
}
