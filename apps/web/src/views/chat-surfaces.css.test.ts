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

describe("round 2: Conversation panel, header and file names", () => {
  const src = (f: string): string => readFileSync(resolve(process.cwd(), "src", f), "utf8");
  it("T-20: the work order page loads dossier.css, which lays out the Activity tab's Conversation panel (no Conversations view is around it)", () => {
    expect(src("views/record.tsx")).toContain("styles/views/dossier.css");
  });
  it("T-21: the thread header wraps instead of running past the page edge", () => {
    const c = css("conv-chat.css");
    expect(c).toMatch(/\.cv-head-bar \{[^}]*flex-wrap: wrap/);
    expect(c).toMatch(/\.cv-head-top \{[^}]*flex-wrap: wrap/);
    expect(c).not.toMatch(/\.cv-title \{[^}]*text-overflow: ellipsis/);
  });
  it("T-22: the Changes file list shows the whole path", () => {
    const s = src("views/changes.tsx");
    expect(s).toMatch(/className="pri wrap-text grow mono small"/);
    expect(s).not.toMatch(/className="pri trunc/);
  });
  it("T-34: the agent-chats screen is one main landmark under the shell's, and the link says where it goes", () => {
    expect(src("views/workspace.tsx")).not.toMatch(/<main /);
    expect(src("views/conversations.tsx")).not.toContain('label="All side threads"');
  });
});
