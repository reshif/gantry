import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, defineConfig } from "@playwright/test";

/**
 * One harness, no live stack (see e2e/fixtures.ts). Projects:
 *  - {light,dark}-{390,1366}: axe and screenshot diffs (the bar's matrix)
 *  - layout-{light,dark}: horizontal overflow at 320/390/768/1024/1366
 *  - behaviour: failure-path interception and persona journeys
 * Browser: Playwright's own Chromium (`npx playwright install chromium`), else GANTRY_E2E_CHROMIUM, else the newest
 * Chromium in the local Playwright cache (so an offline machine with any cached build works).
 */
function chromiumPath(): string | undefined {
  if (process.env.GANTRY_E2E_CHROMIUM) return process.env.GANTRY_E2E_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through to the cache scan */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      const exe = join(cache, d, "chrome-linux64", "chrome");
      if (existsSync(exe)) return exe;
    }
  } catch {
    /* none cached */
  }
  return undefined;
}

const executablePath = chromiumPath();
const PORT = Number(process.env.GANTRY_E2E_PORT ?? 4173);
/**
 * GANTRY_E2E_VISUAL: "off" runs everything but the screenshot diffs, "only" runs only them, unset runs both. Baselines are
 * per platform and per font set (a different machine renders text differently), so CI runs the diffs as a separate,
 * non-blocking step until baselines are generated on the CI image (npm run e2e:update there, commit __screenshots__/linux).
 */
const VISUAL = process.env.GANTRY_E2E_VISUAL;
const matrix = (["light", "dark"] as const).flatMap((scheme) =>
  ([390, 1366] as const).map((w) => ({
    name: `${scheme}-${w}`,
    testMatch: VISUAL === "only" ? ["visual.spec.ts"] : VISUAL === "off" ? ["a11y.spec.ts"] : ["a11y.spec.ts", "visual.spec.ts"],
    use: { colorScheme: scheme, viewport: { width: w, height: w === 390 ? 844 : 800 }, hasTouch: w === 390 },
  })),
);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "e2e/report" }]] : [["list"]],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    ...matrix.map(({ name, testMatch, use }) => ({ name, testMatch, use })),
    ...(VISUAL === "only" ? [] : (["light", "dark"] as const).map((scheme) => ({ name: `layout-${scheme}`, testMatch: "overflow.spec.ts", use: { colorScheme: scheme } }))),
    ...(VISUAL === "only" ? [] : [{ name: "behaviour", testMatch: ["failure-paths.spec.ts", "journeys.spec.ts", "canary.spec.ts", "nav-rail.spec.ts", "work-orders-layout.spec.ts", "drawer-fit.spec.ts", "conv-polish.spec.ts"], use: { colorScheme: "light" as const, viewport: { width: 1366, height: 800 } } }]),
  ],
  webServer: {
    // The real production build, served as the nginx image serves it. Set E2E_SKIP_BUILD=1 to reuse apps/web/dist (it is then
    // your job to have rebuilt it: a stale dist tests old code). A server already on the port is never reused unless
    // E2E_REUSE_SERVER=1, because it may be serving a stale build.
    command: `${process.env.E2E_SKIP_BUILD === "1" ? "" : "npx vite build && "}npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 180_000,
  },
});
