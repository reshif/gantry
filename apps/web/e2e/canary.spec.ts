import { PERSONAS, expect, mockApi, open, test } from "./fixtures";
import { overflowPx, seriousAxe } from "./detectors";

// Canaries: prove the a11y and overflow detectors can fail. Each seeds a real defect into a rendered route and expects the same
// detector the gates use to catch it. If axe or the overflow measurement is ever neutered (a wrong tag set, a swallowed error,
// measuring the wrong element) these fail, which a green gate on clean pages never would.

test("canary: axe catches seeded low-contrast text on a real route", async ({ page }) => {
  await mockApi(page, { persona: PERSONAS.admin });
  await open(page, "/#home");
  expect(await seriousAxe(page), "the seeded defect must be what adds color-contrast").not.toContain("color-contrast");
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "Seeded low contrast text";
    p.setAttribute("style", "color:#bbb;background:#fff;font-size:14px;position:relative;padding:8px");
    (document.querySelector("#main") ?? document.body).prepend(p);
  });
  expect(await seriousAxe(page)).toContain("color-contrast");
});

test("canary: the overflow measurement catches a seeded wide element", async ({ page }) => {
  await mockApi(page, { persona: PERSONAS.admin });
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page, "/#home");
  const before = await overflowPx(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("style", "width:1200px;height:4px;position:absolute;top:0;left:0");
    document.body.append(d);
  });
  expect(await overflowPx(page)).toBeGreaterThan(Math.max(before, 0));
});
