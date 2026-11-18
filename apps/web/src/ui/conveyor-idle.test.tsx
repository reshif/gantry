import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Conveyor, type BeltStation } from "./cr";

const noop = () => undefined;
const st = (id: string, over: Partial<BeltStation> = {}): BeltStation => ({ id, name: id, agent: "A", slots: 3, lane: [], queue: [], gateAfter: null, hasNext: false, ...over });
afterEach(cleanup);

describe("Conveyor idle station", () => {
  it("shows the word idle in the first bay and leaves the other bays empty, only when nothing is active", () => {
    const tok = { id: "WO-1", title: "t", state: "running" as const, pri: "P2", cls: "FEAT", age: "1h" };
    const { container } = render(<Conveyor stations={[st("a"), st("b", { lane: [tok] })]} released={0} onToken={noop} onStation={noop} onGate={noop} onPile={noop} />);
    const a = container.querySelectorAll('.stn[data-s="a"] .bay');
    expect(a.length).toBe(3);
    expect(a[0]?.textContent).toBe("idle");
    expect(a[1]?.textContent).toBe("");
    expect(container.querySelector('.stn[data-s="b"] .idle')).toBeNull();
  });
});
