import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayProvider } from "../ui/Overlay";
import { getPrefs, reloadPrefs, updatePrefs } from "../lib/prefs";
import { ViewAsBanner } from "./StopBanner";

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  reloadPrefs();
});
afterEach(cleanup);

describe("View as banner", () => {
  it("is absent normally, obvious while previewing, and one click stops it", () => {
    render(<OverlayProvider><ViewAsBanner /></OverlayProvider>);
    expect(document.getElementById("viewas-banner")).toBeNull();
    act(() => updatePrefs({ viewAs: "viewer" }));
    expect(screen.getByText(/Viewing as Read-only viewer/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop viewing as" }));
    expect(getPrefs().viewAs).toBe("");
    expect(document.getElementById("viewas-banner")).toBeNull();
  });
});
