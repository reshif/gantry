import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DesignSystemView from "./design-system";
import { OverlayProvider } from "../ui/Overlay";

function mount() {
  return render(<OverlayProvider><DesignSystemView /></OverlayProvider>);
}

describe("design system page (prototype parity)", () => {
  it("lists the type scale with the Label row and the middle-dot separators", () => {
    const { container } = mount();
    expect(screen.getAllByText("WORK ORDER").length).toBe(1);
    expect(screen.getByText("Requested by Meera Iyer · 3h ago")).toBeTruthy();
    expect(container.textContent).toContain("4 8 12 16 20 24 32 40 · Control 32px (40px coarse) · Chip 20px · Row 44px");
  });
  it("draws pipeline, donut, floor tokens, priority tags and no Released chip or bars", () => {
    const { container } = mount();
    expect(container.querySelectorAll(".pipe").length).toBe(2);
    expect(container.querySelectorAll("svg[aria-label='a 6, b 3, c 1']").length).toBe(2);
    expect(container.querySelectorAll(".tok.run, .tok.is-gate, .tok.blk, .tok.que").length).toBe(8);
    expect(container.querySelectorAll(".tag.pri.p3").length).toBe(2);
    expect(screen.queryByText("Toast (error)")).toBeNull();
    expect(container.querySelector(".chip.done")).toBeNull();
  });
  it("links the five shared states and offers Drawer and Command palette", () => {
    mount();
    for (const [name, k] of [["Loading", "loading"], ["Empty", "empty"], ["Error", "error"], ["No access", "forbidden"], ["Conflict", "conflict"]]) {
      expect(screen.getAllByRole("link", { name: name! })[0]!.getAttribute("href")).toBe(`#floor?state=${k}`);
    }
    expect(screen.getAllByRole("button", { name: "Drawer" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Command palette" }).length).toBe(2);
  });
  it("shows the visible switch label and the pipeline at station 5", () => {
    const { container } = mount();
    expect(screen.getAllByText("Switch on").length).toBeGreaterThan(1);
    expect(container.querySelector(".pipe .st.cur")?.textContent).toContain("Build");
  });
  it("the example dialog validates its Name field", () => {
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Dialog" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name is required.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name needs at least 3 characters.")).toBeTruthy();
  });
});
