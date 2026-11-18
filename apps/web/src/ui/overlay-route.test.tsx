import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverlayProvider } from "./Overlay";
import { useUI } from "./overlay-context";

function Opener() {
  const ui = useUI();
  return <button type="button" onClick={() => ui.dialog({ title: "New chat", body: <p>Body</p> })}>open</button>;
}
const go = (hash: string) => act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });

describe("dialogs follow the route", () => {
  it("a route change closes an open dialog; a query-only change on the same screen keeps it", async () => {
    window.location.hash = "#/workspace";
    render(<OverlayProvider><Opener /></OverlayProvider>);
    await act(async () => { screen.getByText("open").click(); });
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await go("#/workspace/abc?tab=x");
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await go("#/account");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
