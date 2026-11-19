import type { QueryClient } from "@tanstack/react-query";
import { connection } from "./store";

/**
 * TanStack evaluates a `refetchInterval` function only when a query's timer is (re)armed (after a fetch, or when options change), not when
 * the connection changes. A read fetched while the stream was up armed no timer, so without this it would stay still after the stream drops.
 * On every flip of `streamDown` this re-applies each mounted observer's options, which re-evaluates its interval (and starts or stops the poll).
 */
export function watchStreamDown(client: QueryClient): () => void {
  let down = connection.get().streamDown;
  return connection.subscribe(() => {
    const now = connection.get().streamDown;
    if (now === down) return;
    down = now;
    for (const q of client.getQueryCache().getAll()) for (const o of q.observers) o.setOptions(o.options);
  });
}
