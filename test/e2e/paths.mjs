// TEST ONLY: where the browser e2e scripts find their helper files and write screenshots. Nothing here is machine specific.
//   E2E_DIR     working directory (default: <os tmpdir>/gantry-e2e); holds psql.sh, routes.json, delays.json
//   E2E_PSQL    executable that runs psql against the stack's database (default: $E2E_DIR/psql.sh)
//   E2E_SHOTS   screenshot directory (default: $E2E_DIR/shots), created on demand
//   E2E_DELAYS  stub delay file read by agent-double.mjs (default: $E2E_DIR/delays.json)
//   E2E_PROJECT compose project name of the stack under test (default: w3e2e for journey/isolation, w4e2e for lib4 scripts)
//   PLAYWRIGHT_INDEX  path to playwright/index.mjs when it is not resolvable as the "playwright" package
//   E2E_CHROME  Chrome/Chromium executable (default: /usr/bin/google-chrome if present, else Playwright's own browser)
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DIR = process.env.E2E_DIR ?? join(tmpdir(), "gantry-e2e");
export const PSQL = process.env.E2E_PSQL ?? join(DIR, "psql.sh");
export const SHOTS = process.env.E2E_SHOTS ?? join(DIR, "shots");
export const DELAYS = process.env.E2E_DELAYS ?? join(DIR, "delays.json");
export const PROJECT_W3 = process.env.E2E_PROJECT ?? "w3e2e";
export const ROUTES = join(DIR, "routes.json");

// Directories are created when a script needs them, not when the constants are imported.
// The working directory is private to the user (it holds an executable helper).
export const ensureDir = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
export const shotPath = (name) => join(ensureDir(SHOTS), name);

/** Loads Playwright from $PLAYWRIGHT_INDEX when set, otherwise as the installed "playwright" package. */
export async function loadPlaywright() {
  const idx = process.env.PLAYWRIGHT_INDEX;
  if (idx) { if (!existsSync(idx)) throw new Error(`PLAYWRIGHT_INDEX does not exist: ${idx}`); return import(idx); }
  try { return await import("playwright"); } catch { throw new Error('Playwright not found: install it (npm i -D playwright) or set PLAYWRIGHT_INDEX to its index.mjs'); }
}
export const chromeOptions = () => {
  const exe = process.env.E2E_CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  return { ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] };
};
export async function launchChromium() { const { chromium } = await loadPlaywright(); return chromium.launch(chromeOptions()); }
