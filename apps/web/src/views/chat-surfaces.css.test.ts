import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// a view stylesheet is split in two: the rules only the view uses (loaded with it) and the shared ones (in the entry CSS)
const css = (f: string): string => {
  const read = (n: string): string => { try { return readFileSync(resolve(process.cwd(), "src/styles/views", n), "utf8"); } catch { return ""; } };
  return read(f) + "\n" + read(f.replace(/\.css$/, ".shared.css"));
};

describe("chat surfaces keep the composer on screen and never clip a bubble", () => {
  it("T-2: on a phone the Console page fills the screen so only the transcript scrolls", () => {
    const c = css("console.css");
    const phone = c.slice(c.indexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/\.view-console-page \{[^}]*height: calc\(100dvh/);
    expect(phone).toMatch(/\.view-console-page \.con2 \{[^}]*flex: 1 1 0/);
  });
  it("T-D2: both transcripts fade at the top edge and keep list items from shrinking", () => {
    expect(css("onboarding-session.css")).toMatch(/\.osx-thread \{ scroll-padding-top: 12px;[^}]*mask-image/);
    expect(css("onboarding-session.css")).toMatch(/\.osx-thread > \* \{ flex: none; \}/);
    expect(css("console.css")).toMatch(/\.con2-log \{ scroll-padding-top: 12px;[^}]*mask-image/);
  });
});
