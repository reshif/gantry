import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs } from "./primitives";

const items = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

function dims(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
}

describe("Tabs overflow cue", () => {
  it("sets no cue when the strip fits", () => {
    const { container } = render(<Tabs items={items} active="a" onChange={() => {}} />);
    expect(container.querySelector(".tabs")?.getAttribute("data-more")).toBeNull();
  });
  it("marks the end, then the start, as the strip scrolls", () => {
    const { container } = render(<Tabs items={items} active="a" onChange={() => {}} />);
    const bar = container.querySelector(".tabs") as HTMLElement;
    dims(bar, 500, 300);
    act(() => { bar.dispatchEvent(new Event("scroll")); });
    expect(bar.getAttribute("data-more")).toBe("end");
    bar.scrollLeft = 200;
    act(() => { bar.dispatchEvent(new Event("scroll")); });
    expect(bar.getAttribute("data-more")).toBe("start");
  });
});
