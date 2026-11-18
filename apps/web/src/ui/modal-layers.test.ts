import { afterEach, describe, expect, it } from "vitest";
import { inertOutside } from "./Modal";

afterEach(() => { document.body.innerHTML = ""; });

describe("inertOutside", () => {
  it("leaves the dialog layer live under a drawer, so a confirm opened from a drawer can be clicked", () => {
    document.body.innerHTML = `<div id="app"></div><div id="layer-drawer"><aside id="d"></aside></div><div id="layer-dialog"><div id="dlg"></div></div>`;
    const undo = inertOutside(document.getElementById("d")!);
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("layer-dialog")!.hasAttribute("inert")).toBe(false);
    undo();
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(false);
  });
  it("still makes the drawer and the page inert under a dialog", () => {
    document.body.innerHTML = `<div id="app"></div><div id="layer-drawer"><aside id="d"></aside></div><div id="layer-dialog"><div id="dlg"></div></div>`;
    inertOutside(document.getElementById("dlg")!);
    expect(document.getElementById("layer-drawer")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(true);
  });
});
