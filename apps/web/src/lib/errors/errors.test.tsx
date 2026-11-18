import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { buildReport, reportError, resetReporter, scrub, setErrorSink, type ErrorReport } from "./reporter";
import { CHUNK_RELOAD_KEY, loadWithRetry } from "./lazyRetry";

beforeEach(() => {
  resetReporter();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  setErrorSink(null);
  vi.restoreAllMocks();
});

describe("reporter", () => {
  it("scrubs emails, tokens, uuids, long numbers and url queries", () => {
    const s = scrub("user asha@acme.dev token=abcdef123456 id 3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f n 1234567 https://x.dev/a?secret=1#frag");
    expect(s).not.toMatch(/asha|acme|abcdef|3f2b8c1e|1234567|secret=|frag/);
    expect(s).toContain("https://x.dev/a");
  });
  it("sends no person data, only route id, and never the hash parameter", () => {
    window.location.hash = "#/p/payments/record/wo-secret-42";
    const e = new Error("failed for asha@acme.dev");
    const r = buildReport(e, "route");
    expect(JSON.stringify(r)).not.toMatch(/asha|acme|wo-secret-42|payments/);
    expect(r.route).toBe("p");
    expect(Object.keys(r).sort()).toEqual(["boundary", "id", "message", "name", "route", "stack", "ts"]);
  });
  it("is a no-op without a sink, but still returns an id", () => {
    expect(reportError(new Error("x"), "root")).toMatch(/^[0-9a-z]{8}$/);
  });
  it("deduplicates within a minute and rate-limits to 10 a minute", () => {
    const got: ErrorReport[] = [];
    setErrorSink((r) => got.push(r));
    reportError(new Error("same"), "route", 1000);
    reportError(new Error("same"), "route", 2000);
    expect(got).toHaveLength(1);
    for (let i = 0; i < 20; i++) reportError(new Error(`e${i}`), "route", 3000);
    expect(got).toHaveLength(10);
    reportError(new Error("later"), "route", 70_000);
    expect(got).toHaveLength(11);
  });
  it("a throwing sink never breaks the app", () => {
    setErrorSink(() => {
      throw new Error("sink");
    });
    expect(() => reportError(new Error("x"), "root")).not.toThrow();
  });
});

function Bomb({ boom }: { boom: boolean }) {
  if (boom) throw new Error("kaboom");
  return <p>fine</p>;
}

describe("AppErrorBoundary", () => {
  it("shows a role=alert fallback with an error id, focuses its heading, and Try again re-renders", () => {
    let boom = true;
    const view = () => (
      <AppErrorBoundary level="route">
        <Bomb boom={boom} />
      </AppErrorBoundary>
    );
    const { rerender } = render(view());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Error id/);
    expect(document.activeElement?.tagName).toBe("H1");
    boom = false;
    rerender(view());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("fine")).toBeTruthy();
  });
  it("the route fallback is the prototype crash sheet: Something went wrong, This sheet failed to draw, Retry and Home", () => {
    render(<AppErrorBoundary level="route"><Bomb boom /></AppErrorBoundary>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByText("This sheet failed to draw")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("#home");
  });
  it("clears itself when the route key changes", () => {
    const { rerender } = render(
      <AppErrorBoundary level="route" resetKey="a">
        <Bomb boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(
      <AppErrorBoundary level="route" resetKey="b">
        <Bomb boom={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });
  it("a chrome failure does not take the route down", () => {
    render(
      <div>
        <AppErrorBoundary level="chrome">
          <Bomb boom />
        </AppErrorBoundary>
        <p>route content</p>
      </div>,
    );
    expect(screen.getByText("route content")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("a chunk-load failure offers Reload only: Try again cannot work because React.lazy caches the rejected import", () => {
    function ChunkBomb(): never {
      throw new Error("Failed to fetch dynamically imported module: /assets/x.js");
    }
    render(
      <AppErrorBoundary level="route">
        <ChunkBomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
  it("nested levels report their own level in situ, and only the route fallback takes focus", () => {
    const got: ErrorReport[] = [];
    setErrorSink((r) => got.push(r));
    render(
      <div>
        <AppErrorBoundary level="chrome">
          <Bomb boom />
        </AppErrorBoundary>
        <AppErrorBoundary level="route">
          <Bomb boom />
        </AppErrorBoundary>
      </div>,
    );
    // same message from two levels: the reporter de-duplicates by message, so check what was recorded plus the DOM
    expect(got.map((r) => r.boundary)).toContain("chrome");
    expect(document.getElementById("error-chrome")).toBeTruthy();
    expect(document.getElementById("error-route")).toBeTruthy();
    expect(document.activeElement?.closest("#error-route")).toBeTruthy();
  });
  it("reports to the sink", () => {
    const got: ErrorReport[] = [];
    setErrorSink((r) => got.push(r));
    render(
      <AppErrorBoundary level="root">
        <Bomb boom />
      </AppErrorBoundary>,
    );
    expect(got[0]?.boundary).toBe("root");
  });
});

describe("loadWithRetry", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const wait = () => Promise.resolve();
  it("retries once and succeeds", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("chunk 404")).mockResolvedValueOnce({ default: 1 });
    await expect(loadWithRetry(f, { wait, storage: mem(), reload: vi.fn() })).resolves.toEqual({ default: 1 });
  });
  it("reloads once when the chunk stays missing, then throws instead of looping", async () => {
    const storage = mem();
    const reload = vi.fn();
    const f = vi.fn().mockRejectedValue(new Error("chunk 404"));
    let t = 100_000;
    const pending = loadWithRetry(f, { wait, storage, reload, now: () => t });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe("100000");
    void pending;
    t += 5000;
    await expect(loadWithRetry(f, { wait, storage, reload, now: () => t })).rejects.toThrow("chunk 404");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
