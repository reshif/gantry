import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "../api/client";
import { Async, failureOf, qState } from "./async";
import { Empty } from "./primitives";

vi.mock("./overlay-context", () => ({ useUI: () => ({ toast: vi.fn() }) }));


type Q<T> = { data: T | undefined; error: unknown; isPending: boolean; isError: boolean; refetch: () => Promise<never> };
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
    expect(screen.getByText("This view failed to load")).toBeTruthy();
    expect(document.getElementById("a-error")?.textContent).toMatch(/Database is down\. Nothing was changed\. Error id: e-[a-z0-9]+/);
    expect(document.getElementById("a-error-reload")).toBeTruthy();
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

  it("keeps showing the last good copy when a refresh fails, and says it is old with a retry", () => {
    const query = q({ data: [1], isPending: false, isError: true, error: new ApiError(500, "Database is down.", null) });
    render(<Async<number[]> query={query} what="rows" id="r">{(d) => <p>{d.length} rows</p>}</Async>);
    expect(screen.getByText("1 rows")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/last loaded copy of rows.*Database is down/);
    fireEvent.click(document.getElementById("r-stale-retry")!);
    expect((query as unknown as { refetch: ReturnType<typeof vi.fn> }).refetch).toHaveBeenCalled();
  });

  it("failureOf and qState keep a hidden number from reading as zero", () => {
    expect(failureOf(new ApiError(403, "", null)).hidden).toBe(true);
    render(<p>{qState(q({ isError: true, error: new ApiError(403, "Nope.", null) }), () => 0)}</p>);
    expect(document.querySelector(".async-stat")?.getAttribute("data-tip")).toMatch(/Not visible to you/);
  });
});
