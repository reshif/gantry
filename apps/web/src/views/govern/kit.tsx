/**
 * Shared bits of the People, Workload and Access sheets (prototype dataView): URL-held view state (`?ppl.tab=teams`),
 * the "1-12 of 20" pager footer and the toolbar "n persons of N / Clear" count. The state lives in the address bar's
 * query string (the hash router owns only the hash), so a filtered view can be linked and survives a reload.
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Btn } from "../../ui/primitives";

const EVENT = "gantry-qs";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(EVENT, fn);
  };
};
const snap = () => window.location.search;

/** One string held in the URL query. `fallback` is the value when the key is absent (and is then not written). */
export function useQS(key: string, fallback = ""): [string, (v: string) => void] {
  const search = useSyncExternalStore(subscribe, snap, () => "");
  const value = new URLSearchParams(search).get(key) ?? fallback;
  const set = useCallback((v: string) => {
    const u = new URL(window.location.href);
    if (v === fallback || v === "") u.searchParams.delete(key);
    else u.searchParams.set(key, v);
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    window.dispatchEvent(new Event(EVENT));
  }, [key, fallback]);
  return [value, set];
}

/** Several keys at once (a filter change also resets the page). */
export function setQS(patch: Record<string, string>): void {
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  window.dispatchEvent(new Event(EVENT));
}

/** Screens that own each govern query prefix; any other screen drops the keys. */
const OWNERS: Record<string, string[]> = { "acc.": ["access"], "ppl.": ["people", "person"] };

/** Remove `acc.*` / `ppl.*` from the query string when the current route is not the one that owns them. */
export function clearGovernQS(routeId: string): void {
  const u = new URL(window.location.href);
  let hit = false;
  for (const k of Array.from(u.searchParams.keys())) {
    const owner = Object.entries(OWNERS).find(([pre]) => k.startsWith(pre));
    if (owner && !owner[1].includes(routeId)) {
      u.searchParams.delete(k);
      hit = true;
    }
  }
  if (!hit) return;
  window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  window.dispatchEvent(new Event(EVENT));
}

export const PAGE_SIZE = 12;

/** Page footer of a data view: "1-12 of 20" and Prev / Next (shown only with more than one page). */
export function Pager({ id, page, size = PAGE_SIZE, total, onPage }: { id: string; page: number; size?: number; total: number; onPage: (p: number) => void }): ReactNode {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.min(page, pages - 1);
  const from = cur * size + 1;
  const to = Math.min(total, (cur + 1) * size);
  return (
    <div className="tfoot" id={id}>
      <span role="status">{`${from}–${to} of ${total}`}</span>
      {pages > 1 ? (
        <div className="row">
          <Btn label="Prev" small id={`${id}-prev`} disabled={cur === 0} onClick={() => cur > 0 && onPage(cur - 1)} />
          <span>{`Page ${cur + 1} / ${pages}`}</span>
          <Btn label="Next" small id={`${id}-next`} disabled={cur >= pages - 1} onClick={() => cur < pages - 1 && onPage(cur + 1)} />
        </div>
      ) : null}
    </div>
  );
}

/** "12 persons" or "3 persons of 20" plus a ghost Clear button while a filter is on. */
export function CountClear({ n, of, noun, many, active, onClear }: { n: number; of: number; noun: string; many?: string; active: boolean; onClear: () => void }): ReactNode {
  const word = n === 1 ? noun : (many ?? `${noun}s`);
  return (
    <>
      {`${n} ${word}${active ? ` of ${of}` : ""}`}
      {active ? <Btn label="Clear" small kind="ghost" onClick={onClear} /> : null}
    </>
  );
}

/** Sort state held in the URL as `key` or `-key`. */
export function parseSort(v: string, fallback: { key: string; dir: 1 | -1 }): { key: string; dir: 1 | -1 } {
  if (!v) return fallback;
  return v.startsWith("-") ? { key: v.slice(1), dir: -1 } : { key: v, dir: 1 };
}
export const sortParam = (s: { key: string; dir: 1 | -1 }): string => (s.dir === -1 ? `-${s.key}` : s.key);

/** Prototype scrollWrap: a horizontally scrolling region with a "scroll →" cue chip and edge fades while more lies to the right. */
export function ScrollCue({ children, maxHeight, label }: { children: ReactNode; maxHeight?: number; label: string }): ReactNode {
  const [more, setMore] = useState(false);
  const [left, setLeft] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The scrolling element is the Table primitive's own `.table-scroll` wrapper when the children are a Table, else our own region.
  const target = (): HTMLElement | null => ref.current?.querySelector<HTMLElement>(".table-scroll") ?? ref.current;
  const measure = useCallback(() => {
    const el = ref.current?.querySelector<HTMLElement>(".table-scroll") ?? ref.current;
    if (!el) return;
    setLeft(el.scrollLeft > 4);
    setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  useLayoutEffect(() => {
    const el = target();
    if (!el) return undefined;
    if (maxHeight) { el.style.maxHeight = `${maxHeight}px`; el.style.overflow = "auto"; }
    measure();
    el.addEventListener("scroll", measure);
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); el.removeEventListener("scroll", measure); };
  }, [measure, maxHeight]);
  return (
    <div className={`scrollwrap${left ? " ml" : ""}${more ? " mr" : ""}`}>
      <div className="sf l" aria-hidden="true" />
      <div className="sf r" aria-hidden="true" />
      <div className="sh" aria-hidden="true">scroll {"→"}</div>
      <div ref={ref} className="tw" tabIndex={0} role="region" aria-label={label} onScroll={measure}>{children}</div>
    </div>
  );
}
