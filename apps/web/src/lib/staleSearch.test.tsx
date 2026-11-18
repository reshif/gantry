import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDropStaleSearch } from "./staleSearch";

function Probe() { useDropStaleSearch(); return null; }
const go = (hash: string) => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); };

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); window.location.hash = ""; });

describe("a screen's location.search does not ride along to the next screen", () => {
  it("drops ?tab=budget when the route changes from project-config to models, keeps the hash", () => {
    window.history.replaceState(null, "", "/?tab=budget#project-config");
    render(<Probe />);
    go("#models");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#models");
  });

  it("keeps it while the route stays the same (tabs and filters of one screen)", () => {
    window.history.replaceState(null, "", "/?tab=budget#project-config");
    render(<Probe />);
    go("#project-config/budget");
    expect(window.location.search).toBe("?tab=budget");
    go("#project-config?x=1");
    expect(window.location.search).toBe("?tab=budget");
  });
});
