import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tip } from "./Tip";
import { Btn, FilterBar, SearchBox, Stat, StatRow } from "./primitives";
import { GateMark, PipelineRail, PipelineRow, StationChip } from "./pipeline";

afterEach(cleanup);

describe("locked button", () => {
  it("explains itself to assistive tech through the shared tooltip node, and on focus", () => {
    render(
      <>
        <Tip />
        <Btn label="Kill project" id="k" guard={{ allowed: false, reason: "Only a Factory Admin can stop the line.", needs: "Factory Admin" }} />
      </>,
    );
    const b = screen.getByRole("button", { name: "Kill project" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("aria-describedby")).toBe("tip");
    expect(document.getElementById("tip")).toBeTruthy();
    fireEvent.focusIn(b);
    expect(document.getElementById("tip")?.textContent).toBe("Factory Admin. Only a Factory Admin can stop the line.");
  });

  it("does not point at the tooltip when nothing is locked", () => {
    render(<Btn label="Save" />);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-describedby")).toBeNull();
  });
});

describe("stat tiles and filter bar", () => {
  it("renders tiles in a row with label, value and note", () => {
    render(
      <StatRow>
        <Stat label="Work in flight" value="13" sub="4 running now" />
        <Stat label="Stuck" value="3" tone="block" />
      </StatRow>,
    );
    expect(screen.getByText("Work in flight")).toBeTruthy();
    expect(screen.getByText("4 running now")).toBeTruthy();
    expect(document.querySelectorAll(".stat-row > .stat-tile")).toHaveLength(2);
    expect(document.querySelector(".stat-tile.tone-block")).toBeTruthy();
  });

  it("puts the count and actions after the filters and labels the search", () => {
    let q = "";
    render(
      <FilterBar count="21 of 21" actions={<button type="button">Export</button>}>
        <SearchBox value={q} onChange={(v) => (q = v)} placeholder="Id or title" />
      </FilterBar>,
    );
    fireEvent.change(screen.getByLabelText("Id or title"), { target: { value: "wo" } });
    expect(q).toBe("wo");
    expect(screen.getByRole("status").textContent).toBe("21 of 21");
    expect(screen.getByRole("search", { name: "Filters" })).toBeTruthy();
  });
});

describe("pipeline pieces", () => {
  it("says each station's state in words, not colour alone", () => {
    render(<StationChip name="Build" state="failed" />);
    expect(screen.getByText(", failed")).toBeTruthy();
  });

  it("draws stations with the gates between them", () => {
    render(
      <PipelineRow
        steps={[
          { key: "a", name: "Intake", state: "passed", gate: { state: "passed", label: "Brief confirmed: clear" } },
          { key: "b", name: "Build", state: "running" },
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Brief confirmed: clear" })).toBeTruthy();
    render(<GateMark state="wait" label="Review gate: waiting" />);
    expect(screen.getByRole("img", { name: "Review gate: waiting" })).toBeTruthy();
  });

  it("renders the large rail with a gate marker and a word for each step", () => {
    render(
      <PipelineRail
        steps={[
          { key: "a", name: "Intake", tone: "done", gate: { tone: "warn", label: "Brief gate: waiting" } },
          { key: "b", name: "Spec", tone: "todo" },
        ]}
      />,
    );
    expect(screen.getByText(", done")).toBeTruthy();
    expect(screen.getByText(", not started")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Brief gate: waiting" })).toBeTruthy();
  });
});
