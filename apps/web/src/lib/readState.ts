/**
 * An honest view of a read, for code that needs the rows outside `<Async>`.
 *
 * `query.data ?? []` turns a failed or hidden read into an empty list, so a screen says "nothing here" when the truth is
 * "couldn't load" or "not visible to you". `readOf` keeps those apart: only `status: "ready"` carries data, and a failed
 * refresh with data in hand is `ready` with `stale: true` (show the old copy, say it is old, offer retry).
 */
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../api/client";

type Q<T> = Pick<UseQueryResult<T>, "data" | "error" | "isPending" | "isError" | "refetch">;

export type Read<T> =
  | { status: "loading" }
  | { status: "hidden"; msg: string }
  | { status: "failed"; msg: string; retry: () => void }
  | { status: "ready"; data: T; /** A refresh failed; `data` is the last good copy. */ stale: boolean; msg: string; retry: () => void };

function messageOf(error: unknown): { hidden: boolean; msg: string } {
  if (error instanceof ApiError) {
    if (error.status === 403) return { hidden: true, msg: error.message || "Your roles don't include this." };
    if (error.status === 0) return { hidden: false, msg: "Could not reach Gantry. Check your connection." };
    return { hidden: false, msg: error.message || `The server answered ${error.status}.` };
  }
  return { hidden: false, msg: error instanceof Error && error.message ? error.message : "Something went wrong." };
}

export function readOf<T>(q: Q<T>): Read<T> {
  const retry = () => void q.refetch();
  if (q.data !== undefined) {
    const f = q.isError ? messageOf(q.error) : null;
    return { status: "ready", data: q.data, stale: !!f, msg: f?.msg ?? "", retry };
  }
  if (q.isError) {
    const f = messageOf(q.error);
    return f.hidden ? { status: "hidden", msg: f.msg } : { status: "failed", msg: f.msg, retry };
  }
  return { status: "loading" };
}

/** The rows when the read is ready, and `undefined` otherwise. Never an empty list standing in for "unknown". */
export function rowsOf<T>(q: Q<T[]>): T[] | undefined {
  const r = readOf(q);
  return r.status === "ready" ? r.data : undefined;
}
