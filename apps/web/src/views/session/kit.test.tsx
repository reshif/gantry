import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadEnd } from "./kit";

afterEach(cleanup);

function Thread({ n }: { n: number }) {
  const thread = useThreadEnd<HTMLDivElement>(n);
  return <div className="osx-thread" data-testid="thread" ref={thread} />;
}

describe("useThreadEnd", () => {
  it("scrolls the thread itself to its newest message, and never scrolls the page or an ancestor", () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    const { getByTestId, rerender } = render(<Thread n={1} />);
    const el = () => getByTestId("thread");
    expect(el().scrollTop).toBe(900);
    el().scrollTop = 10;
    rerender(<Thread n={1} />);
    expect(el().scrollTop).toBe(10); // nothing new: the reader's place is kept
    rerender(<Thread n={2} />);
    expect(el().scrollTop).toBe(900);
    expect(into).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });
});
