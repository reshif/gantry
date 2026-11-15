import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "../api/client";
import { Async, failureOf, qState, useCommand } from "./async";
import { Empty } from "./primitives";

vi.mock("./overlay-context", () => ({ useUI: () => ({ toast: toastSpy }) }));
const toastSpy = vi.fn();

type Q<T> = { data: T | undefined; error: unknown; isPending: boolean; isError: boolean; refetch: () => Promise<never> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = <T,>(over: Partial<Q<T>>): any => ({ data: undefined, error: null, isPending: true, isError: false, refetch: vi.fn(), ...over });

describe("Async", () => {
  it("says Not visible to you on a 403, never an empty list", () => {
    render(<Async query={q({ isError: true, error: new ApiError(403, "Needs mcp.view.", null) })} what="MCP servers" id="x" empty={<Empty title="No MCP servers yet" />}>{() => <p>rows</p>}</Async>);
    expect(screen.getByText("Not visible to you")).toBeTruthy();
    expect(screen.getByText("Needs mcp.view.")).toBeTruthy();
    expect(screen.queryByText("No MCP servers yet")).toBeNull();
  });

  it("says what failed and retries on other errors", () => {
    const query = q({ isError: true, error: new ApiError(500, "Database is down.", null) });
    render(<Async query={query} what="audit entries" id="a">{() => null}</Async>);
    expect(screen.getByText("Couldn't load audit entries")).toBeTruthy();
    fireEvent.click(document.getElementById("a-error-retry")!);
    expect((query as unknown as { refetch: ReturnType<typeof vi.fn> }).refetch).toHaveBeenCalled();
  });

  it("shows the screen's empty state for empty data, and the data otherwise", () => {
    const { rerender } = render(<Async<number[]> query={q({ data: [] as number[], isPending: false })} what="rows" empty={<Empty title="Nothing yet" />}>{(d) => <p>{d.length} rows</p>}</Async>);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    rerender(<Async<number[]> query={q({ data: [1, 2], isPending: false })} what="rows" empty={<Empty title="Nothing yet" />}>{(d) => <p>{d.length} rows</p>}</Async>);
    expect(screen.getByText("2 rows")).toBeTruthy();
  });

  it("keeps showing stale data when a refetch fails", () => {
    render(<Async<number[]> query={q({ data: [1], isError: true, error: new ApiError(500, "x", null) })} what="rows">{(d) => <p>{d.length} rows</p>}</Async>);
    expect(screen.getByText("1 rows")).toBeTruthy();
  });

  it("failureOf and qState keep a hidden number from reading as zero", () => {
    expect(failureOf(new ApiError(403, "", null)).hidden).toBe(true);
    render(<p>{qState(q({ isError: true, error: new ApiError(403, "Nope.", null) }), () => 0)}</p>);
    expect(document.querySelector(".async-stat")?.getAttribute("data-tip")).toMatch(/Not visible to you/);
  });
});

describe("useCommand", () => {
  function Probe({ fn }: { fn: () => Promise<{ ok: boolean; msg: string }> }) {
    const c = useCommand(fn, { ok: "Saved." });
    return <button type="button" onClick={() => void c.run()}>{c.busy ? "busy" : "idle"}</button>;
  }

  it("runs once per click while busy, and toasts the outcome", async () => {
    let resolve: (v: { ok: boolean; msg: string }) => void = () => undefined;
    const fn = vi.fn(() => new Promise<{ ok: boolean; msg: string }>((r) => (resolve = r)));
    render(<Probe fn={fn} />);
    const b = screen.getByRole("button");
    fireEvent.click(b);
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.textContent).toBe("busy");
    await act(async () => resolve({ ok: true, msg: "" }));
    expect(b.textContent).toBe("idle");
    expect(toastSpy).toHaveBeenLastCalledWith("Saved.", "ok");
  });

  it("toasts the refusal reason", async () => {
    render(<Probe fn={() => Promise.resolve({ ok: false, msg: "Needs Project Admin." })} />);
    await act(async () => fireEvent.click(screen.getByRole("button")));
    expect(toastSpy).toHaveBeenLastCalledWith("Needs Project Admin.", "error");
  });
});
