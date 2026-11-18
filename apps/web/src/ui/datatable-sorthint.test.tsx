import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

const cols = [{ key: "a", label: "Name", sort: (r: { a: string }) => r.a, render: (r: { a: string }) => r.a }];
const rows = [{ a: "x" }, { a: "y" }];

describe("DataTable sortHint", () => {
  afterEach(cleanup);
  it("shows the idle sort hint and no Sort by select when asked", () => {
    const { container } = render(<DataTable sortHint columns={cols} rows={rows} rowKey={(r) => r.a} />);
    expect(container.querySelector(".th-arrow.sorthint")?.textContent).toBe("↕");
    expect(container.querySelector(".dtable-sortsel")).toBeNull();
  });
  it("keeps the old behaviour by default", () => {
    const { container } = render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.a} />);
    expect(container.querySelector(".sorthint")).toBeNull();
    expect(container.querySelector(".dtable-sortsel")).not.toBeNull();
  });
});
