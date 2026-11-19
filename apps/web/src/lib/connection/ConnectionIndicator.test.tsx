import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { connection } from "./store";

afterEach(() => { cleanup(); connection.reset(); });

describe("ConnectionIndicator", () => {
  it("a tab the server paused says so and offers Reconnect, which restarts the stream", () => {
    const restart = vi.fn();
    connection.streamWanted(true, restart);
    connection.streamOpened();
    render(<ConnectionIndicator />);
    expect(screen.getByRole("status").textContent).toContain("Live");
    act(() => connection.superseded());
    expect(screen.getByRole("status").textContent).toContain("Paused");
    expect(screen.getByRole("status").textContent).toContain("Opened in another tab");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).not.toContain("Paused");
  });
});
