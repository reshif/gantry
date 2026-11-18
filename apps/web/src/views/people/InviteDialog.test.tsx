import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ops } from "../../api/ops";
import { OverlayProvider, Dialog } from "../../ui/Overlay";
import { InviteForm } from "./InviteDialog";

afterEach(cleanup);
describe("Invite dialog dirty guard (gov1-036)", () => {
  it("asks before discarding when a field was edited, not when untouched", () => {
    let closed = 0;
    const body = <InviteForm perm={{ allowed: true, reason: "", needs: "" } as never} teams={[]} projects={[]} roles={[{ id: "engineer", name: "Engineer", level: "project" }] as never} domains={[]} preset={{}} close={() => undefined} onDone={() => undefined} registerSubmit={() => undefined} />;
    render(<QueryClientProvider client={new QueryClient()}><OverlayProvider><Dialog title="Invite" body={body} actions={[{ label: "Cancel" }]} onClose={() => { closed++; }} /></OverlayProvider></QueryClientProvider>);
    fireEvent.change(document.querySelector("input")!, { target: { value: "Ana" } });
    // a dirty form asks with the browser's confirm (the prototype's way): answering no keeps the dialog, yes closes it
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(closed).toBe(0);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closed).toBe(1);
    confirm.mockRestore();
  });

  it("closes after a successful send even when the reply names no person (gov1-035)", async () => {
    vi.spyOn(ops, "invite").mockResolvedValue({ ok: true, msg: "ok" } as never);
    let submit: () => void = () => undefined;
    let closed = 0;
    const roles = [{ id: "engineer", name: "Engineer", level: "project" }] as never;
    render(<QueryClientProvider client={new QueryClient()}><OverlayProvider><InviteForm perm={{ allowed: true, reason: "", needs: "" } as never} teams={[]} projects={[]} roles={roles} domains={[]} preset={{}} close={() => { closed++; }} onDone={() => undefined} registerSubmit={(fn) => { submit = fn; }} /></OverlayProvider></QueryClientProvider>);
    fireEvent.change(document.getElementById("ppl-inv-name")!, { target: { value: "Test Person" } });
    fireEvent.change(document.getElementById("ppl-inv-email")!, { target: { value: "test.person@acme.dev" } });
    submit();
    await vi.waitFor(() => expect(closed).toBe(1));
  });
});
