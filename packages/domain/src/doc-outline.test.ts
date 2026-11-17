import { describe, expect, it } from "vitest";
import { docHeadings, headingText } from "./doc-outline.js";

describe("docHeadings", () => {
  it("lists headings outside code fences, with emphasis marks removed and links and HTML left as written", () => {
    const md = "# T\r\n\r\n## See [a](https://x.dev) <b>x</b>\r\n\r\n```\r\n## no\r\n```\r\n\r\n### **Bold** `c` ###\r\n    ## indented is not a heading";
    expect(docHeadings(md)).toEqual([
      { level: 1, text: "T" },
      { level: 2, text: "See [a](https://x.dev) <b>x</b>" },
      { level: 3, text: "Bold c" },
    ]);
    expect(headingText("  *a*_b_ ")).toBe("ab");
  });
});
