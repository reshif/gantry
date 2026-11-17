import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCommand, describeRefusal } from "./useCommand";
import { CommandError } from "../ui/CommandError";

const toastSpy = vi.fn();
vi.mock("../ui/overlay-context", () => ({ useUI: () => ({ toast: toastSpy }) }));

type R = { ok: boolean; msg: string; status?: number; retryAfter?: number };
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

function Probe({ fn }: { fn: () => Promise<R> }) {
  const c = useCommand(fn, { ok: "Saved.", toastFail: false });
  return (
    <>
      <button type="button" onClick={() => void c.run()}>{c.busy ? "busy" : "idle"}</button>
      <CommandError error={c.error} onDismiss={c.reset} />
    </>
  );
}

beforeEach(() => toastSpy.mockClear());

describe("useCommand", () => {
  it("runs once per click while busy and toasts the outcome", async () => {
    let resolve: (v: R) => void = () => undefined;
    const fn = vi.fn(() => new Promise<R>((r) => (resolve = r)));
    wrap(<Probe fn={fn} />);
    const b = screen.getByRole("button");
    fireEvent.click(b);
    fireEvent.click(b);
    await waitFor(() => expect(b.textContent).toBe("busy"));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, msg: "" }));
    await waitFor(() => expect(b.textContent).toBe("idle"));
    expect(toastSpy).toHaveBeenLastCalledWith("Saved.", "ok");
  });

  it("keeps a refusal as a sticky role=alert until dismissed", async () => {
    wrap(<Probe fn={() => Promise.resolve({ ok: false, msg: "Needs Project Admin.", status: 403 })} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toContain("Needs Project Admin.");
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not throw or update after unmount when the command finishes late", async () => {
    let resolve: (v: R) => void = () => undefined;
    const { unmount } = wrap(<Probe fn={() => new Promise<R>((r) => (resolve = r))} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("busy"));
    unmount();
    await act(async () => resolve({ ok: true, msg: "" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Saved.", "ok"));
  });

  it("turns a thrown error into a refusal instead of an unhandled rejection", async () => {
    wrap(<Probe fn={() => Promise.reject(new Error("boom"))} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(toastSpy).not.toHaveBeenCalledWith("Saved.", "ok"));
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("idle"));
  });
});

describe("describeRefusal", () => {
  it("maps 401/409/412/429/0 to plain next steps", () => {
    expect(describeRefusal({ msg: "", status: 401 })).toMatch(/Sign in again.*draft is kept/);
    expect(describeRefusal({ msg: "", status: 409 })).toMatch(/changed since you loaded/);
    expect(describeRefusal({ msg: "", status: 412 })).toMatch(/changed since you loaded/);
    expect(describeRefusal({ msg: "slow down", status: 429, retryAfter: 7 })).toBe("Too many requests. Try again in 7 seconds.");
    expect(describeRefusal({ msg: "", status: 0 })).toMatch(/may not have gone through/);
    expect(describeRefusal({ msg: "Name is required.", status: 422 })).toBe("Name is required.");
  });
});
