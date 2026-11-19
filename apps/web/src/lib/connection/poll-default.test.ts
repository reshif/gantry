import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { makeQueryClient, STREAM_DOWN_POLL_MS } from "../../App";
import { connection } from "./store";
import { watchStreamDown } from "./rearm";

beforeEach(() => { vi.useFakeTimers(); connection.reset(); });
afterEach(() => { vi.useRealTimers(); connection.reset(); });

describe("every live read refreshes while the stream is down (S-25), and never while it is up (F-09)", () => {
  it("a plain query with no interval of its own polls only once the stream drops", async () => {
    const qc = makeQueryClient();
    let n = 0;
    const obs = new QueryObserver(qc, { queryKey: ["floor", "p1"], queryFn: async () => ++n });
    const off = obs.subscribe(() => undefined);
    const unwatch = watchStreamDown(qc);
    connection.streamWanted(true);
    connection.streamOpened();
    await vi.advanceTimersByTimeAsync(STREAM_DOWN_POLL_MS * 3);
    expect(n).toBe(1);
    connection.streamDropped();
    await vi.advanceTimersByTimeAsync(STREAM_DOWN_POLL_MS * 2 + 100);
    expect(n).toBeGreaterThanOrEqual(2);
    const before = n;
    connection.streamOpened();
    await vi.advanceTimersByTimeAsync(STREAM_DOWN_POLL_MS * 3);
    expect(n).toBe(before);
    off();
    unwatch();
  });
});
