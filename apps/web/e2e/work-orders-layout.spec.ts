import { devSeed } from "@gantry/domain";
import { PERSONAS, expect, fulfillJson, mockApi, open, test } from "./fixtures";

const SEED = devSeed(Date.now()).state;
const PAYMENTS = SEED.projects.find((p) => p.id === "payments");
const WOS = SEED.workOrders.filter((w) => w.project === "payments");
const REPOS = SEED.repos.filter((r) => r.project === "payments");

// The work orders list keeps every column, Actions included, inside the table's own visible width at laptop widths (no scrolling
// inside the table to reach the buttons), and a title never wraps past two lines.
for (const w of [1280, 1366, 1440]) {
  test(`work orders list fits its table at ${w}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    await mockApi(page, {
      persona: PERSONAS.admin,
      overrides: {
        "projects/payments": (r) => fulfillJson(r, { ...PAYMENTS, version: 1 }),
        "projects/payments/repos": (r) => fulfillJson(r, REPOS),
        "projects/payments/work-orders": (r) => fulfillJson(r, { items: WOS, next: null, total: WOS.length }),
      },
    });
    await open(page, "/#/p/payments/work-orders");
    const table = page.locator("#wo-table-wrap .dtable-scroll").first();
    await table.waitFor();
    const m = await table.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(m.scroll, `the table scrolls sideways at ${w}px (${m.scroll} > ${m.client})`).toBeLessThanOrEqual(m.client + 1);
    const act = page.locator("#wo-table-wrap td:last-child .btn").first();
    await act.waitFor();
    const box = await act.boundingBox();
    const wrap = await table.boundingBox();
    expect(box!.x + box!.width, "the first row action ends inside the table").toBeLessThanOrEqual(wrap!.x + wrap!.width + 1);
    if (process.env.WO_SHOT) await page.screenshot({ path: process.env.WO_SHOT });
    const lines = await page.locator("#wo-table-wrap .wo-title").evaluateAll((els) => Math.max(...els.map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)))));
    expect(lines, "a title wraps to more than 2 lines").toBeLessThanOrEqual(2);
  });
}

// T-42: at 390 a work order is a card without the NEEDS caption line (median about 180px, was about 220px), and Approve is whole.
test("work order cards at 390 stay short", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockApi(page, {
    persona: PERSONAS.admin,
    overrides: {
      "projects/payments": (r) => fulfillJson(r, { ...PAYMENTS, version: 1 }),
      "projects/payments/repos": (r) => fulfillJson(r, REPOS),
      "projects/payments/work-orders": (r) => fulfillJson(r, { items: WOS, next: null, total: WOS.length }),
    },
  });
  await open(page, "/#/p/payments/work-orders");
  const rows = page.locator("#wo-table-wrap tbody tr");
  await rows.first().waitFor();
  if (process.env.WO_SHOT) await page.screenshot({ path: process.env.WO_SHOT, fullPage: true });
  const heights = await rows.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  const sorted = [...heights].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  expect(median, `median row ${median}px (${heights.join(",")})`).toBeLessThanOrEqual(190);
});
