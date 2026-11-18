import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";
import { ExtLink, safeExternalUrl } from "./ExtLink";
import { Modal } from "./Modal";
import { Field, focusFirstInvalid } from "./primitives";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DataTable clickable rows", () => {
  const rows = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];
  const cols = [{ key: "name", label: "Name", sort: true }, { key: "id", label: "Id" }];

  it("puts a named button in the first cell and never makes the row focusable", () => {
    const open = vi.fn();
    const { container } = render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRow={open} />);
    expect(container.querySelectorAll("tr[tabindex]").length).toBe(0);
    const btn = screen.getByRole("button", { name: "Alpha" });
    expect(btn.closest("td")).toBe(container.querySelector("tbody tr td"));
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith(rows[0]);
  });

  it("clicking elsewhere on the row opens it, but a nested control does not", () => {
    const open = vi.fn();
    const inner = vi.fn();
    const c = [{ key: "name", label: "Name" }, { key: "id", label: "Id", render: () => <button type="button" onClick={inner}>Menu</button> }];
    render(<DataTable columns={c} rows={rows} rowKey={(r) => r.id} onRow={open} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Menu" })[0]!);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Beta").closest("tr")!);
    expect(open).toHaveBeenCalledWith(rows[1]);
  });

  it("adds no second control when the first cell already has its own link", () => {
    const c = [{ key: "name", label: "Name", render: (r: { name: string }) => <a href={`#${r.name}`}>{r.name}</a> }];
    const { container } = render(<DataTable columns={c} rows={rows} rowKey={(r) => r.id} onRow={() => {}} />);
    expect(container.querySelectorAll("td .row-link").length).toBe(0);
    expect(screen.getAllByRole("link").length).toBe(2);
  });

  it("uses a real link for rowHref and honours rowLabel", () => {
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} rowHref={(r) => `#/x/${r.id}`} rowLabel={(r) => `Open ${r.name}`} />);
    expect(screen.getByRole("link", { name: "Open Alpha" }).getAttribute("href")).toBe("#/x/a");
  });

  it("offers a sort picker for the card layout and load-more for server paging", () => {
    const more = vi.fn();
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} hasMore total={10} onLoadMore={more} />);
    expect(screen.getByLabelText("Sort by")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Showing 2 of 10");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(more).toHaveBeenCalled();
  });
});

describe("Field wiring", () => {
  it("links label, description and error to the control", () => {
    render(<Field label="Name" description="Shown on the card" error="Required" required><input className="input" /></Field>);
    const input = screen.getByLabelText(/Name/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toEqual(["Shown on the card", "Required"]);
    expect(screen.getByRole("alert").textContent).toBe("Required");
  });

  it("keeps the caller's id and is valid (no aria-invalid) without an error", () => {
    render(<Field label="Email" hint="h"><input id="mine" className="input" /></Field>);
    const input = screen.getByLabelText("Email");
    expect(input.id).toBe("mine");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("focusFirstInvalid focuses the first invalid control", () => {
    const { container } = render(<form><Field label="A"><input className="input" /></Field><Field label="B" error="bad"><input className="input" /></Field></form>);
    expect(focusFirstInvalid(container)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("B"));
  });
});

describe("Modal", () => {
  function Harness({ dirty = false }: { dirty?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <main id="app"><button type="button" onClick={() => setOpen(true)}>Open</button></main>
        {open ? <Modal title="Edit" dirty={dirty} onClose={() => setOpen(false)} footer={<button type="button">Save</button>}><input aria-label="Field" /></Modal> : null}
      </>
    );
  }

  it("makes the background inert, focuses in, and returns focus to the opener on close", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Field"));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(document.getElementById("app")!.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab inside, even after focus lands on non-focusable text", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    (document.activeElement as HTMLElement).blur();
    document.body.focus();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("Escape closes a clean dialog but asks first when dirty", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(confirm).toHaveBeenCalledWith("Discard what you typed?");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a click on the scrim does not discard dirty input", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<Harness dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const scrim = container.querySelector(".scrim")!;
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("ExtLink", () => {
  it("opens http(s) in a new tab with a safe rel, a cue and the host", () => {
    render(<ExtLink href="https://example.com/a?b=1" showHost>Docs</ExtLink>);
    const a = screen.getByRole("link");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a.textContent).toContain("(example.com)");
    expect(a.textContent).toContain("opens in a new tab");
  });

  it("renders javascript:, data: and relative hrefs as plain text, not links", () => {
    for (const h of ["javascript:alert(1)", "data:text/html,x", "/relative", "", null]) {
      const { unmount } = render(<ExtLink href={h}>Label</ExtLink>);
      expect(screen.queryByRole("link")).toBeNull();
      unmount();
    }
    expect(safeExternalUrl("ftp://x")).toBeNull();
  });
});
