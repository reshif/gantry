import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Panel } from "./primitives";

describe("Panel (precision theme)", () => {
  it("is a flat frame by default: no data-hot, so no corner ticks", () => {
    render(<Panel title="Plain">x</Panel>);
    expect(screen.getByRole("region", { name: "Plain" }).hasAttribute("data-hot")).toBe(false);
  });
  it("marks the one drawing canvas with data-hot, which keeps the ticks", () => {
    render(<Panel title="Canvas" hot>x</Panel>);
    expect(screen.getByRole("region", { name: "Canvas" }).hasAttribute("data-hot")).toBe(true);
  });
});
