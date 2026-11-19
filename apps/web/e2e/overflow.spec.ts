import { PERSONAS, expect, hashOf, mockApi, open, routesFor, test } from "./fixtures";
import { overflowPx } from "./detectors";
import { loadKnown, recordOverflow, updating } from "./known";

// No horizontal page overflow (scrollWidth <= innerWidth) at the five layout widths, light and dark (the project).
// Known overflows are listed in e2e/known-issues.json; a new one fails, a fixed one is reported as stale.
const WIDTHS = [320, 390, 768, 1024, 1366];

for (const w of WIDTHS) {
  for (const route of routesFor(PERSONAS.admin)) {
    test(`${route.id} at ${w}`, async ({ page }, info) => {
      await page.setViewportSize({ width: w, height: 800 });
      await mockApi(page, { persona: PERSONAS.admin });
      await open(page, hashOf(route));
      const over = await overflowPx(page);
      const key = `${route.id}@${w}|${info.project.name}`;
      if (updating()) return recordOverflow(key, over > 0);
      const known = loadKnown().overflow.includes(key);
      if (known && over <= 0) info.annotations.push({ type: "stale-known-issue", description: `${key} no longer overflows; remove it from known-issues.json` });
      if (!known) expect(over, `${route.id} overflows the page by ${over}px at ${w}px`).toBeLessThanOrEqual(0);
    });
  }
}
