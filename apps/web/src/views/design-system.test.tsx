import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "../ui/Overlay";
import DesignSystemView from "./design-system";

describe("design system page", () => {
  it("shows the tokens and the components in both themes", () => {
    render(<OverlayProvider><DesignSystemView /></OverlayProvider>);
    expect(screen.getByRole("heading", { name: "Design system" })).toBeTruthy();
    expect(screen.getAllByText("Primary").length).toBe(2);
    expect(document.querySelectorAll("[data-theme=light]").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".tabs-w .tab").length).toBe(6);
    // the prototype's sections: pipeline, donut, floor tokens, priority pills, label row, overlay buttons and the five state links
    expect(document.querySelectorAll(".pipe .st").length).toBe(18);
    expect(document.querySelectorAll("svg[aria-label='a 6, b 3, c 1']").length).toBe(2);
    expect(document.querySelectorAll(".tok").length).toBe(8);
    expect(document.querySelectorAll(".tag.pri").length).toBe(6);
    expect(screen.getAllByText("WORK ORDER").length).toBe(1);
    for (const l of ["Drawer", "Command palette"]) expect(screen.getAllByRole("button", { name: l }).length).toBe(2);
    const hrefs = Array.from(document.querySelectorAll("a.btn")).map((a) => a.getAttribute("href") ?? "");
    for (const s of ["loading", "empty", "error", "forbidden", "conflict"]) expect(hrefs.some((h) => h.endsWith(`floor?state=${s}`))).toBe(true);
    expect(screen.queryByText("Released status")).toBeNull();
  });
});
