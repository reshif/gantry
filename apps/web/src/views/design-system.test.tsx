import { fireEvent, render, screen } from "@testing-library/react";
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
  });
  it("draws the sample meters in the prototype tones (warn at 72, bad at 92)", () => {
    render(<OverlayProvider><DesignSystemView /></OverlayProvider>);
    expect(document.querySelectorAll(".meter.warn").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".meter.bad").length).toBeGreaterThan(0);
  });
  it("keeps Table selected when the static segmented sample is clicked", () => {
    render(<OverlayProvider><DesignSystemView /></OverlayProvider>);
    fireEvent.click(document.querySelector("label[for=ds-seg-cards]") as Element);
    expect((document.getElementById("ds-seg-table") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("ds-seg-cards") as HTMLInputElement).checked).toBe(false);
  });
});
