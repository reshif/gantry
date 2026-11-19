import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
import { Modal } from "./Modal";
import { OverlayProvider } from "./Overlay";
import { useUI } from "./overlay-context";
import { Field } from "./primitives";

afterEach(cleanup);
const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

function MenuInModal() {
  const ui = useUI();
  const [clicked, setClicked] = useState("");
  return (
    <>
      <main id="app"><span data-testid="clicked">{clicked}</span></main>
      <Modal title="Row" onClose={() => {}} footer={<button type="button">Save</button>}>
        <button type="button" aria-label="Row actions" onClick={(e) => ui.menu(e.currentTarget, "Actions", [{ label: "Move up", onClick: () => setClicked("up") }])}>...</button>
      </Modal>
    </>
  );
}

describe("popovers opened from inside a layer", () => {
  it("stay live (not inert) and a menu item is clickable", () => {
    render(<OverlayProvider><MenuInModal /></OverlayProvider>);
    const trigger = screen.getByRole("button", { name: "Row actions" });
    trigger.focus();
    fireEvent.click(trigger);
    const pop = document.getElementById("layer-pop")!;
    expect(pop.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(screen.getByTestId("clicked").textContent).toBe("up");
  });

  it("Escape inside the menu closes the menu, not the dialog underneath", () => {
    render(<OverlayProvider><MenuInModal /></OverlayProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Row actions" }));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move up" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Row" })).toBeTruthy();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("Modal focus return with an autoFocus child", () => {
  it("returns focus to the opener, not the detached input", () => {
    function H() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {open ? <Modal title="Rename" onClose={() => setOpen(false)}><input aria-label="Name" autoFocus /></Modal> : null}
        </>
      );
    }
    render(<H />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(document.activeElement).toBe(opener);
  });

  it("moves focus into the discard question, and Escape there means keep editing", () => {
    render(<Modal title="Edit" dirty onClose={() => {}}><input aria-label="F" /></Modal>);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    const alert = screen.getByRole("alertdialog");
    expect(alert.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("self-hosted fonts and target rules", () => {
  it("index.html loads no external stylesheet or font origin and the font files exist", () => {
    const html = read("index.html");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    const css = read("src/styles/tokens.css");
    const files = [...css.matchAll(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) expect(existsSync(resolve(root, "src/assets/fonts", f))).toBe(true);
    expect(css).not.toMatch(/url\(["']?https?:/);
  });

  it("keeps the 24px floor on small controls and the 44px size only on coarse pointers", () => {
    const css = read("src/styles/system.css");
    const at = css.indexOf("@media (pointer: coarse)");
    expect(at).toBeGreaterThan(0);
    expect(css.slice(0, at)).toMatch(/\.btn[^{]*\.menu-item \{ min-height: var\(--target-min\); \}/);
    expect(css.slice(0, at)).toMatch(/\.icon-btn[^{]*\{ min-width: var\(--target-min\); \}/);
    expect(css.slice(0, at)).not.toMatch(/target-coarse/);
    expect(css.slice(at)).toMatch(/\.btn:not\(\.btn-sm\)[^}]*min-height: var\(--target-coarse\)/);
    const tokens = read("src/styles/tokens.css");
    expect(tokens).toMatch(/--target-min:\s*24px/);
    expect(tokens).toMatch(/--target-coarse:\s*44px/);
  });
});

describe("DataTable details", () => {
  const rows = [{ id: "a", name: "Beta" }, { id: "b", name: "Alpha" }, { id: "c", name: "Gamma" }];
  const cols = [{ key: "name", label: "Name", sort: true }, { key: "id", label: "Id" }];
  const order = (): string[] => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.getAttribute("data-key") ?? "");

  it("the sort picker sorts, and Default order restores the given order", () => {
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} />);
    const picker = screen.getByLabelText("Sort by");
    fireEvent.change(picker, { target: { value: "name" } });
    expect(order()).toEqual(["b", "a", "c"]);
    fireEvent.change(picker, { target: { value: "" } });
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("gives every row without its own control a first-cell button, and skips rows that have one", () => {
    const c = [{ key: "name", label: "Name", render: (r: { id: string; name: string }) => (r.id === "b" ? <a href="#x">{r.name}</a> : r.name) }];
    const { container } = render(<DataTable columns={c} rows={rows} rowKey={(r) => r.id} onRow={() => {}} />);
    const tr = (k: string) => container.querySelector(`tr[data-key="${k}"]`)!;
    expect(tr("a").querySelectorAll("td:first-child button").length).toBe(1);
    expect(tr("b").querySelectorAll("td:first-child button").length).toBe(0);
    expect(tr("c").querySelectorAll("td:first-child button").length).toBe(1);
  });

  it("starts over at the first page when the row count or page size changes", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `N${i}` }));
    const { rerender } = render(<DataTable columns={cols} rows={many} rowKey={(r) => r.id} pageSize={5} />);
    fireEvent.click(screen.getByRole("button", { name: /Show 5 more/ }));
    expect(order().length).toBe(10);
    rerender(<DataTable columns={cols} rows={many.slice(0, 11)} rowKey={(r) => r.id} pageSize={5} />);
    expect(order().length).toBe(5);
    rerender(<DataTable columns={cols} rows={many.slice(0, 11)} rowKey={(r) => r.id} pageSize={3} />);
    expect(order().length).toBe(3);
  });
});

describe("Field wiring edge cases", () => {
  function Custom(props: Record<string, unknown>) {
    return <div data-testid="custom" data-props={Object.keys(props).sort().join(",")} />;
  }
  it("does not push id or aria props into a custom component that did not name an id", () => {
    render(<Field label="X" error="bad" required><Custom /></Field>);
    expect(screen.getByTestId("custom").getAttribute("data-props")).toBe("");
  });
  it("wires a child input that has no id to htmlFor, with description and error", () => {
    render(<Field label="Name" htmlFor="the-id" description="Hint" error="Oops"><input /></Field>);
    const input = screen.getByLabelText("Name");
    expect(input.id).toBe("the-id");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((input.getAttribute("aria-describedby") ?? "").split(" ").length).toBe(2);
  });
});

describe("DataTable paged footer (prototype pager)", () => {
  it("shows 1-N of M with Prev, Page x / y and Next, not Show more", () => {
    const cols = [{ key: "id", label: "Id" }];
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `r${i}` }));
    const { container } = render(<DataTable columns={cols} rows={many} rowKey={(r) => r.id} pageSize={12} paged />);
    const foot = container.querySelector(".tfoot")!;
    expect(foot.textContent).toContain("1–12 of 13");
    expect(foot.textContent).toContain("Page 1 / 2");
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    expect((screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelector(".tfoot")!.textContent).toContain("13–13 of 13");
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
  });
});

describe("read-only refusal", () => {
  it("a locked Btn names its reason in a title and raises a red toast when pressed", async () => {
    const { Btn } = await import("./primitives");
    const { UIContext } = await import("./overlay-context");
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const toast = vi.fn();
    render(
      <UIContext.Provider value={{ toast } as never}>
        <Btn label="Approve" guard={{ allowed: false, reason: "Your role is read-only for this action.", needs: "" }} />
      </UIContext.Provider>,
    );
    const b = screen.getByRole("button", { name: "Approve" });
    expect(b.getAttribute("title")).toBe("Your role is read-only for this action.");
    fireEvent.click(b);
    expect(toast).toHaveBeenCalledWith("Your role is read-only for this action.", "error");
  });
});
