/** The two detectors the a11y and overflow gates use, in one place so the canary tests exercise the very same code. */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Ids of the serious and critical axe violations on the page. */
export async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(AXE_TAGS).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
}

/** How many px the page is wider than the viewport (<= 0 means none). */
export const overflowPx = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
