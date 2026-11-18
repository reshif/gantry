import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog } from "./Overlay";

afterEach(cleanup);

describe("Dialog footer", () => {
  it("renders no empty footer bar when the body brings its own buttons", () => {
    render(<Dialog title="Decide" body={<div className="dlg-f"><button type="button">Approve</button></div>} actions={[]} onClose={() => {}} />);
    expect(document.querySelectorAll(".dlg-foot").length).toBe(0);
  });
  it("renders the footer when there are actions", () => {
    render(<Dialog title="Decide" body="x" actions={[{ label: "Close" }]} onClose={() => {}} />);
    expect(document.querySelectorAll(".dlg-foot").length).toBe(1);
  });
});
