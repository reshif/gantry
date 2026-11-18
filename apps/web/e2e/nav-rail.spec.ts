import { PERSONAS, expect, mockApi, open, test } from "./fixtures";

// The collapsible left nav: icon rail, section folds, the "[" key, remembered choices, flyout labels, badges as dots.
const HOME_WITH_INBOX = { approvals: [{ wo: "WO-1", gate: "G3", title: "A", project: "payments" }], conversations: [] };
const wide = { width: 1440, height: 900 };

test.beforeEach(async ({ page }) => {
  await mockApi(page, { persona: PERSONAS.admin, overrides: { home: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(HOME_WITH_INBOX) }) } });
});

const side = (page: import("@playwright/test").Page) => page.locator("#side");
const width = async (page: import("@playwright/test").Page) => Math.round((await side(page).boundingBox())?.width ?? 0);

test("the Gantry mark collapses the nav to a rail and back, and the choice survives a reload", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  const toggle = page.getByRole("button", { name: "Collapse navigation" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await width(page)).toBeGreaterThan(200);
  await toggle.click();
  const expand = page.getByRole("button", { name: "Expand navigation" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => width(page)).toBeLessThan(70);
  await page.reload();
  await page.waitForSelector("#side");
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
  expect(await width(page)).toBeLessThan(70);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect.poll(() => width(page)).toBeGreaterThan(200);
});

test("the [ key toggles the rail, but not while typing in a field", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  await page.keyboard.press("[");
  await expect.poll(() => width(page)).toBeLessThan(70);
  await page.keyboard.press("[");
  await expect.poll(() => width(page)).toBeGreaterThan(200);
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "probe"; document.body.append(i); i.focus(); });
  await page.keyboard.type("[");
  expect(await width(page)).toBeGreaterThan(200);
  await expect(page.locator("#probe")).toHaveValue("[");
});

test("a section folds on its own with aria-expanded, keeps the current page, and is remembered", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  const head = side(page).getByRole("button", { name: /^Overview/ });
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(side(page).getByRole("link", { name: "Projects" })).toBeVisible();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(side(page).getByRole("link", { name: "Projects" })).toHaveCount(0);
  await expect(side(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await page.reload();
  await page.waitForSelector("#side");
  await expect(side(page).getByRole("button", { name: /^Overview/ })).toHaveAttribute("aria-expanded", "false");
  await side(page).getByRole("button", { name: /^Overview/ }).click();
  await expect(side(page).getByRole("link", { name: "Projects" })).toBeVisible();
});

test("in the rail every destination stays reachable by click, with the Inbox count as a dot", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  await page.keyboard.press("[");
  await expect.poll(() => width(page)).toBeLessThan(70);
  const dot = side(page).locator("a .cnt").first();
  await expect(dot).toBeVisible();
  const box = await dot.boundingBox();
  expect(box && box.width < 16).toBe(true);
  const links = side(page).locator("a[href]:not(.brand-name)");
  expect(await links.count()).toBeGreaterThanOrEqual(8);
  for (const name of ["Home", "Inbox", "Projects", "Agents at work", "Console"]) {
    const link = side(page).getByRole("link", { name: new RegExp(`^${name}`) });
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  // a section folded earlier never hides destinations in the rail
  await expect(side(page).locator(".sec-tag").first()).toBeVisible();
});

test("keyboard focus on a rail icon shows its flyout label and the badge text; Escape dismisses it", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  await page.keyboard.press("[");
  await expect.poll(() => width(page)).toBeLessThan(70);
  await side(page).getByRole("link", { name: /^Inbox/ }).focus();
  const fly = page.locator("#nav-fly");
  await expect(fly).toBeVisible();
  await expect(fly).toContainText("Inbox");
  await expect(fly).toContainText("waiting");
  await page.keyboard.press("Escape");
  await expect(fly).toHaveCount(0);
});

test("at 1100px the nav defaults to the rail unless the person chose; at 390px it stays a drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await open(page, "/#home");
  expect(await width(page)).toBeLessThan(70);
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect.poll(() => width(page)).toBeGreaterThan(200);
  await page.reload();
  await page.waitForSelector("#side");
  expect(await width(page)).toBeGreaterThan(200);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.locator("#nav-rail-toggle")).toHaveCount(0);
});

test("the content reflows beside the rail with no overlap and no horizontal overflow", async ({ page }) => {
  await page.setViewportSize(wide);
  await open(page, "/#home");
  await page.keyboard.press("[");
  await expect.poll(() => width(page)).toBeLessThan(70);
  const sideRight = (await side(page).boundingBox())!.x + (await width(page));
  const mainLeft = (await page.locator(".main").boundingBox())!.x;
  expect(mainLeft).toBeGreaterThanOrEqual(sideRight - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
