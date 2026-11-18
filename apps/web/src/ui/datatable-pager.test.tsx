import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

const rows = Array.from({ length: 30 }, (_, i) => ({ id: `R${i + 1}` }));

describe("DataTable prototype pager and selection", () => {
  it("pages with Prev / Next and selects a page with the header checkbox", () => {
    render(<DataTable id="t" columns={[{ key: "id", label: "ID" }]} rows={rows} rowKey={(r) => r.id} pageSize={12} pager selectable />);
    expect(screen.getByRole("status").textContent).toBe("1–12 of 30");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByRole("status").textContent).toBe("13–24 of 30");
    fireEvent.click(screen.getByLabelText("Select page"));
    expect((screen.getByLabelText("Select R13") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText("Prev"));
    expect((screen.getByLabelText("Select R1") as HTMLInputElement).checked).toBe(false);
  });
});
