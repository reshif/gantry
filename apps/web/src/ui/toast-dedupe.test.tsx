import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "./Overlay";
import { useUI } from "./overlay-context";

function Fire() {
  const ui = useUI();
  return <button type="button" onClick={() => ui.toast("Instructions are too short.", "warn")}>fire</button>;
}

describe("toast", () => {
  it("does not stack a second copy of a message that is still showing", () => {
    render(<OverlayProvider><Fire /></OverlayProvider>);
    const b = screen.getByText("fire");
    act(() => { fireEvent.click(b); });
    act(() => { fireEvent.click(b); });
    expect(screen.getAllByText("Instructions are too short.")).toHaveLength(1);
  });
});
