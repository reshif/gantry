import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { backoffDelay, parseChange, startStream, type EventSourceLike } from "./stream";
import { bindQueryClient, expandSlices, onCanInvalidated } from "./keys";

describe("keys", () => {
  it("expands a slice to its dependents once", () => {
    const k = expandSlices(["workOrders", "audit", "workOrders"]);
    expect(k).toContain("floor");
    expect(k).toContain("home");
    expect(k.filter((x) => x === "workOrders")).toHaveLength(1);
  });
});

describe("parseChange", () => {
  it("reads keys and project, ignores junk", () => {
    expect(parseChange('{"keys":["workOrders","audit"],"project":"p1"}')).toEqual({ keys: ["workOrders", "audit"], project: "p1" });
    expect(parseChange('{"keys":[1,"x"]}')).toEqual({ keys: ["x"] });
    expect(parseChange("nope")).toBeNull();
    expect(parseChange('{"a":1}')).toBeNull();
  });
});

describe("backoff", () => {
  it("grows, is jittered within [base/2, base], and caps at 30s", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30000);
  });
});

function fakeSource() {
  const handlers: Record<string, (ev: MessageEvent) => void> = {};
  const es = {
    close: vi.fn(),
    addEventListener: (t: string, fn: (ev: MessageEvent) => void) => {
      handlers[t] = fn;
    },
    onopen: null,
    onerror: null,
  } as unknown as EventSourceLike & { onopen: (() => void) | null; onerror: (() => void) | null };
  return { es, emit: (data: string) => handlers.change?.({ data } as MessageEvent), fire: (t: string) => handlers[t]?.({ data: "{}" } as MessageEvent) };
}

describe("startStream", () => {
  it("invalidates the named slices (and dependents) on change", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    bindQueryClient(qc);
    const src = fakeSource();
    const stop = startStream({ create: () => src.es });
    src.emit('{"keys":["workOrders"],"project":"p1"}');
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(["workOrders", "floor", "home"]));
    stop();
    bindQueryClient(null);
  });

  it("does not reconnect after the server says the stream was superseded", () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const stop = startStream({
      create: () => { const s = fakeSource(); sources.push(s); return s.es; },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => undefined,
    });
    sources[0]!.fire("superseded");
    expect(sources[0]!.es.close).toHaveBeenCalled();
    (sources[0]!.es.onerror as () => void)();
    expect(timers).toHaveLength(0);
    expect(sources).toHaveLength(1);
    stop();
  });

  it("clears the can() cache when a decision input changes", () => {
    const fn = vi.fn();
    const off = onCanInvalidated(fn);
    const src = fakeSource();
    const stop = startStream({ create: () => src.es });
    src.emit('{"keys":["matrix"]}');
    expect(fn).toHaveBeenCalledTimes(1);
    src.emit('{"keys":["audit"]}');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    stop();
  });

  it("reconnects with backoff after an error and resets after open", () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const stop = startStream({
      create: () => {
        const s = fakeSource();
        sources.push(s);
        return s.es;
      },
      random: () => 1,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    const first = sources[0]!.es as unknown as { onerror: () => void; onopen: () => void };
    first.onerror();
    expect(timers.at(-1)?.ms).toBe(1000);
    timers.at(-1)!.fn();
    expect(sources).toHaveLength(2);
    (sources[1]!.es as unknown as { onerror: () => void }).onerror();
    expect(timers.at(-1)?.ms).toBe(2000);
    timers.at(-1)!.fn();
    (sources[2]!.es as unknown as { onopen: () => void }).onopen();
    (sources[2]!.es as unknown as { onerror: () => void }).onerror();
    expect(timers.at(-1)?.ms).toBe(1000);
    stop();
    timers.at(-1)!.fn(); // a pending reconnect after stop does nothing
    expect(sources).toHaveLength(3);
  });
});
