import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = (f: string): string => readFileSync(resolve(process.cwd(), "src/styles/views", f), "utf8");

describe("chat surfaces keep the composer on screen and never clip a bubble", () => {
  it("T-2: on a phone the Console page fills the screen so only the transcript scrolls", () => {
    const c = css("console.css");
    const phone = c.slice(c.lastIndexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/\.view-console-page \{[^}]*height: calc\(100dvh/);
    expect(phone).toMatch(/\.view-console-page \.con2 \{[^}]*flex: 1 1 0/);
  });
  it("T-D2: both transcripts fade at the top edge and keep list items from shrinking", () => {
    expect(css("onboarding-session.css")).toMatch(/\.osx-thread \{ scroll-padding-top: 12px;[^}]*mask-image/);
    expect(css("onboarding-session.css")).toMatch(/\.osx-thread > \* \{ flex: none; \}/);
    expect(css("console.css")).toMatch(/\.con2-log \{ scroll-padding-top: 12px;[^}]*mask-image/);
  });
});
