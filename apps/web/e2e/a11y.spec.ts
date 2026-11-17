import AxeBuilder from "@axe-core/playwright";
import { PERSONAS, expect, hashOf, mockApi, open, routesFor, test } from "./fixtures";
import { diffRules, loadKnown, recordA11y, updating } from "./known";

// axe (wcag2a, 2aa, 21aa, 22aa) at 390 and 1366, light and dark (the project), for two personas on every route.
// Serious and critical findings fail unless e2e/known-issues.json already lists that rule for that page (a ratchet).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function serious(page: import("@playwright/test").Page): Promise<string[]> {
  const res = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(TAGS).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
}

function check(key: string, found: string[], info: { annotations: Array<{ type: string; description?: string }> }) {
  if (updating()) return recordA11y(key, found);
  const { fresh, stale } = diffRules(loadKnown(), key, found);
  if (stale.length) info.annotations.push({ type: "stale-known-issue", description: `${key}: ${stale.join(", ")} no longer occurs; remove it from known-issues.json` });
  expect(fresh, `new serious/critical axe issues on ${key}`).toEqual([]);
}

test("sign-in screen", async ({ page }, info) => {
  await mockApi(page, { persona: null });
  await open(page, "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  check(`signin|${info.project.name}`, await serious(page), info);
});

for (const persona of Object.values(PERSONAS)) {
  for (const route of routesFor(persona)) {
    test(`${persona.id}: ${route.id}`, async ({ page }, info) => {
      await mockApi(page, { persona });
      await open(page, hashOf(route));
      check(`${persona.id}|${route.id}|${info.project.name}`, await serious(page), info);
    });
  }
}
