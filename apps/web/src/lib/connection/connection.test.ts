import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createCoalescer } from "./coalesce";
import { connection, pollWhenStreamDown, startConnectionWatch } from "./store";
import { startStream, type EventSourceLike } from "../../api/stream";
import { bindQueryClient } from "../../api/keys";

beforeEach(() => connection.reset());
afterEach(() => connection.reset());

describe("coalescer", () => {
  it("merges a burst into one trailing flush with the union of keys", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const c = createCoalescer(flush, { waitMs: 200 });
    c.add(["workOrders"]);
    c.add(["audit", "workOrders"]);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]![0].sort()).toEqual(["audit", "workOrders"]);
    vi.useRealTimers();
  });
  it("cancel drops pending keys", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const c = createCoalescer(flush, { waitMs: 200 });
    c.add(["a"]);
    c.cancel();
    vi.advanceTimersByTime(500);
    expect(flush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("connection store", () => {
  it("is live with no stream wanted, reconnecting until the stream opens, polls only while down", () => {
    const poll = pollWhenStreamDown(5000);
    expect(connection.get().state).toBe("live");
    expect(poll()).toBe(false);
    connection.streamWanted(true);
    expect(connection.get().state).toBe("reconnecting");
    expect(poll()).toBe(5000);
    connection.streamOpened();
    expect(connection.get().state).toBe("live");
    expect(poll()).toBe(false);
    connection.streamDropped();
    expect(poll()).toBe(5000);
  });
  it("reports offline from the browser's online/offline events", () => {
    const stop = startConnectionWatch({ setInterval: () => 0 as never, clearInterval: () => {} });
    connection.streamWanted(true);
    connection.streamOpened();
    window.dispatchEvent(new Event("offline"));
    expect(connection.get().state).toBe("offline");
    expect(connection.get().streamDown).toBe(true);
    window.dispatchEvent(new Event("online"));
    expect(connection.get().state).toBe("live");
    stop();
  });
  it("watchdog: silent + probe ok stays live; silent + probe fails flips to reconnecting and restarts the stream", async () => {
    let t = 1000;
    const restart = vi.fn();
    connection.streamWanted(true, restart);
    connection.streamOpened(t);
    let tick: () => void = () => {};
    const probe = vi.fn().mockResolvedValueOnce(new Response("ok")).mockRejectedValueOnce(new Error("net"));
    const stop = startConnectionWatch({ staleMs: 60_000, now: () => t, probe, setInterval: (fn) => ((tick = fn), 0 as never), clearInterval: () => {} });
    t += 30_000;
    tick();
    expect(probe).not.toHaveBeenCalled(); // recently alive
    t += 40_000;
    tick();
    await vi.waitFor(() => expect(connection.get().lastAlive).toBe(t));
    expect(connection.get().state).toBe("live");
    t += 61_000;
    tick();
    await vi.waitFor(() => expect(connection.get().state).toBe("reconnecting"));
    expect(restart).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("startStream wiring", () => {
  function fakeSource() {
    const handlers: Record<string, (ev: MessageEvent) => void> = {};
    const es = { close: vi.fn(), addEventListener: (t: string, fn: (ev: MessageEvent) => void) => (handlers[t] = fn), onopen: null, onerror: null } as unknown as EventSourceLike & { onopen: () => void; onerror: () => void };
    return { es, emit: (d: string) => handlers.change?.({ data: d } as MessageEvent) };
  }
  it("coalesces a burst of change events into one invalidation per slice and tracks open/drop", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    bindQueryClient(qc);
    const src = fakeSource();
    const stop = startStream({ create: () => src.es, coalesceMs: 250 });
    expect(connection.get().state).toBe("reconnecting");
    src.es.onopen();
    expect(connection.get().state).toBe("live");
    for (let i = 0; i < 20; i++) src.emit('{"keys":["workOrders"]}');
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys.filter((k) => k === "workOrders")).toHaveLength(1);
    src.es.onerror();
    expect(connection.get().streamDown).toBe(true);
    stop();
    expect(connection.get().streamDown).toBe(false);
    bindQueryClient(null);
    vi.useRealTimers();
  });
});
