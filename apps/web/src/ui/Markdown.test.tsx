import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, outlineOf } from "./Markdown";
import { lineDiff } from "./linediff";

describe("Markdown (shared renderer)", () => {
  it("renders headings with anchors, tables, quotes, rules, task lists and nested items; raw HTML stays text", () => {
    const md = "# Title\n\n## Findings\n\n- one\n  - nested\n- [x] done\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n## Findings\n";
    const { container } = render(<Markdown text={md} idPrefix="t" />);
    expect(container.querySelector("h2#t-title")?.textContent).toBe("Title");
    expect(container.querySelectorAll("h3").length).toBe(2);
    expect(container.querySelector("#t-findings-2")).toBeTruthy();
    expect(container.querySelector("li ul li")?.textContent).toBe("nested");
    expect(container.querySelector(".md-task.is-done")).toBeTruthy();
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(container.querySelector("hr")).toBeTruthy();
    expect(container.querySelector("td")?.textContent).toBe("1");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(outlineOf(md, "t").map((h) => h.id)).toEqual(["t-title", "t-findings", "t-findings-2"]);
  });

  it("only links to http(s) and anchors", () => {
    const { container } = render(<Markdown text="[ok](https://example.com) [bad](javascript:alert(1))" />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  });

  it("chat mode shows headings as bold lines", () => {
    const { container } = render(<Markdown text="## Plan" headings={false} />);
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("Plan");
  });

  it("line diff keeps common lines and marks the rest", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([{ op: "same", text: "a" }, { op: "del", text: "b" }, { op: "add", text: "B" }, { op: "same", text: "c" }, { op: "add", text: "d" }]);
  });
});
