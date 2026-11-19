/**
 * What a person keeps about their own table: which columns they show and the views they saved. Both are per-person conveniences kept in
 * this browser only; the page works the same without them (storage may be blocked), so every read and write is guarded.
 */
import { useCallback, useState } from "react";

export type GroupBy = "none" | "station" | "repo" | "cls" | "assignee";

export interface SavedView {
  id: string;
  name: string;
  tab: string;
  filters: Record<string, string>;
  sort: { k: string; dir: 1 | -1 };
  groupBy: GroupBy;
  hidden: string[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
}

/** A value kept in this browser under `key` (it is read again when the key changes, such as another project), starting from `fallback`. */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [st, setSt] = useState<{ key: string; v: T }>(() => ({ key, v: read(key, fallback) }));
  const cur = st.key === key ? st.v : read(key, fallback);
  if (st.key !== key) setSt({ key, v: cur });
  const set = useCallback(
    (n: T) => {
      setSt({ key, v: n });
      write(key, n);
    },
    [key],
  );
  return [cur, set];
}

export const savedViewsKey = (project: string): string => `gantry.wo.views.${project}`;
export const columnsKey = (project: string): string => `gantry.wo.columns.${project}`;
