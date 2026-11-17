import { PERSONAS, expect, mockApi, open, test } from "./fixtures";

// Screenshot diff baselines for 390 and 1366 in light and dark (the project). Baselines are committed under
// e2e/__screenshots__; regenerate with `npm run e2e:update -w @gantry/web` and review the images. Add a route here when its
// view is migrated: the baseline is what keeps a later change from regressing it.
const SCREENS: Array<{ name: string; hash: string; persona: keyof typeof PERSONAS | null }> = [
  { name: "sign-in", hash: "/", persona: null },
  { name: "home", hash: "/#home", persona: "admin" },
  { name: "projects", hash: "/#projects", persona: "admin" },
];

for (const s of SCREENS) {
  test(`screenshot ${s.name}`, async ({ page }) => {
    await mockApi(page, { persona: s.persona ? PERSONAS[s.persona] : null });
    await open(page, s.hash);
    await expect(page).toHaveScreenshot(`${s.name}.png`);
  });
}
