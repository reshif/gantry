import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useLeaveGuard, pageHasUnsaved } from "./useLeaveGuard";
import { Dialog } from "../ui/Overlay";

function Form({ dirty }: { dirty: boolean }) {
  useLeaveGuard(dirty);
  return <input aria-label="name" />;
}

afterEach(() => vi.restoreAllMocks());

describe("useLeaveGuard on the page", () => {
  it("asks before unload only while dirty", () => {
    const { rerender } = render(<Form dirty={false} />);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    rerender(<Form dirty />);
    expect(pageHasUnsaved()).toBe(true);
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    rerender(<Form dirty={false} />);
    expect(pageHasUnsaved()).toBe(false);
  });

  it("asks on in-app navigation and puts the old route back when declined", async () => {
    window.location.hash = "#agents";
    await waitFor(() => expect(window.location.hash).toBe("#agents"));
    const { unmount } = render(<Form dirty />);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.location.hash = "#models";
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(window.location.hash).toBe("#agents"));
    unmount();
  });

  it("lets navigation through when confirmed", async () => {
    window.location.hash = "#agents";
    await waitFor(() => expect(window.location.hash).toBe("#agents"));
    const { unmount } = render(<Form dirty />);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.location.hash = "#skills";
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(window.location.hash).toBe("#skills");
    unmount();
  });
});

describe("a dirty dialog", () => {
  const open = (dirty: boolean, onClose: () => void) =>
    render(<Dialog title="Edit" body={<Form dirty={dirty} />} onClose={onClose} />);

  it("closes straight away when nothing was typed", () => {
    const onClose = vi.fn();
    open(false, onClose);
    fireEvent.click(document.querySelector(".scrim")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("asks before a scrim click, Escape or Cancel discards typed input", () => {
    const onClose = vi.fn();
    open(true, onClose);
    fireEvent.click(document.querySelector(".scrim")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toMatch(/unsaved/);
    fireEvent.click(screen.getByText("Keep editing"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Discard changes"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
