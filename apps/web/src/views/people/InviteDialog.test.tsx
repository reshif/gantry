import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayProvider, Dialog } from "../../ui/Overlay";
import { InviteForm } from "./InviteDialog";

afterEach(cleanup);
describe("Invite dialog dirty guard (gov1-036)", () => {
  it("asks before discarding when a field was edited, not when untouched", () => {
    let closed = 0;
    const body = <InviteForm perm={{ allowed: true, reason: "", needs: "" } as never} teams={[]} projects={[]} roles={[{ id: "engineer", name: "Engineer", level: "project" }] as never} domains={[]} preset={{}} close={() => undefined} onDone={() => undefined} registerSubmit={() => undefined} />;
    render(<QueryClientProvider client={new QueryClient()}><OverlayProvider><Dialog title="Invite" body={body} actions={[{ label: "Cancel" }]} onClose={() => { closed++; }} /></OverlayProvider></QueryClientProvider>);
    fireEvent.change(document.querySelector("input")!, { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard your unsaved changes?")).toBeTruthy();
    expect(closed).toBe(0);
  });
});
