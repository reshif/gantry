/**
 * Shared data and write states. Every screen loads, fails, comes back empty and is refused the same way:
 *
 *  - `Async` wraps one read. While it loads it shows a quiet placeholder. A 403 says "Not visible to you",
 *    never an empty list or a 0. Any other failure says what failed and offers Try again. An empty
 *    result shows the screen's own empty state. Only real data reaches `children`.
 *  - `useCommand` (lib/useCommand) wraps one write; re-exported here.
 *  - `qState` gives a header stat the same honesty: "…" while loading, "–" with the reason when hidden or failed.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import "../lib/data.css";
import { Icon } from "./Icon";
import { Btn, Empty } from "./primitives";

/** Why a read failed, in words for the person looking at the screen. */
export function failureOf(error: unknown): { hidden: boolean; msg: string } {
  if (error instanceof ApiError) {
    if (error.status === 403) return { hidden: true, msg: error.message || "Your roles don't include this." };
    if (error.status === 404) return { hidden: false, msg: "It no longer exists, or it was moved." };
    if (error.status === 0) return { hidden: false, msg: "Could not reach Gantry. Check your connection." };
    return { hidden: false, msg: error.message || `The server answered ${error.status}.` };
  }
  return { hidden: false, msg: error instanceof Error && error.message ? error.message : "Something went wrong." };
}

/** A placeholder that appears only after a short delay, so fast loads don't flash. */
export function Loading({ label, rows = 3, id }: { label: string; rows?: number; id?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 180);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="async-loading" id={id} role="status" aria-live="polite" aria-label={`Loading ${label}`}>
      {show ? Array.from({ length: rows }, (_, i) => <span key={i} className="async-bar skel" style={{ width: `${92 - i * 14}%` }} />) : null}
    </div>
  );
}

export function NotVisible({ what, reason, id }: { what: string; reason?: string; id?: string }) {
  return <Empty id={id} icon="lock" title="Not visible to you" text={reason ? `${reason}` : `Your roles don't include ${what}.`} />;
}

export function LoadFailed({ what, msg, onRetry, id }: { what: string; msg: string; onRetry?: () => void; id?: string }) {
  return (
    <Empty
      id={id}
      icon="alert"
      tone="block"
      title={`Couldn't load ${what}`}
      text={msg}
      action={onRetry ? <Btn small icon="refresh" label="Try again" id={id ? `${id}-retry` : undefined} onClick={onRetry} /> : undefined}
    />
  );
}

interface AsyncProps<T> {
  query: Pick<UseQueryResult<T>, "data" | "error" | "isPending" | "isError" | "refetch">;
  /** What is being loaded, in the words the empty and error states use: "MCP servers". */
  what: string;
  /** True when the data has nothing to show. Defaults to an empty array or an empty `items` page. */
  isEmpty?: (d: T) => boolean;
  /** The screen's own empty state. Without it, empty data is passed to `children`. */
  empty?: ReactNode;
  /** Prefix for the state ids (`${id}-loading`, `${id}-hidden`, `${id}-error`). */
  id?: string;
  rows?: number;
  children: (data: T) => ReactNode;
}

const defaultEmpty = (d: unknown): boolean => (Array.isArray(d) ? d.length === 0 : !!d && typeof d === "object" && Array.isArray((d as { items?: unknown }).items) ? (d as { items: unknown[] }).items.length === 0 : false);

export function Async<T>({ query, what, isEmpty = defaultEmpty, empty, id, rows, children }: AsyncProps<T>) {
  if (query.isError && query.data === undefined) {
    const f = failureOf(query.error);
    return f.hidden ? <NotVisible id={id ? `${id}-hidden` : undefined} what={what} reason={f.msg} /> : <LoadFailed id={id ? `${id}-error` : undefined} what={what} msg={f.msg} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) return <Loading id={id ? `${id}-loading` : undefined} label={what} rows={rows} />;
  const stale = query.isError ? failureOf(query.error) : null;
  const strip = stale ? (
    <div className="async-stale banner warn" role="alert" id={id ? `${id}-stale` : undefined}>
      <span>{`Showing the last loaded copy of ${what}. Couldn't refresh: ${stale.msg}`}</span>
      <Btn small icon="refresh" label="Try again" id={id ? `${id}-stale-retry` : undefined} onClick={() => void query.refetch()} />
    </div>
  ) : null;
  if (empty !== undefined && isEmpty(query.data)) return <>{strip}{empty}</>;
  return <>{strip}{children(query.data)}</>;
}

/** A header stat value that is honest about a read that is loading, hidden or failed. */
export function qState<T>(q: Pick<UseQueryResult<T>, "data" | "error" | "isError">, value: (d: T) => ReactNode): ReactNode {
  if (q.data !== undefined) return value(q.data);
  if (q.isError) {
    const f = failureOf(q.error);
    return (
      <span className="muted async-stat" data-tip={f.hidden ? `Not visible to you. ${f.msg}` : `Couldn't load. ${f.msg}`} tabIndex={0}>
        {f.hidden ? <Icon name="lock" /> : "–"}
      </span>
    );
  }
  return <span className="muted async-stat">…</span>;
}

/** The one write path lives in lib/useCommand (TanStack useMutation); re-exported so existing imports keep working. */
export { useCommand } from "../lib/useCommand";
