#!/usr/bin/env node
/**
 * Fidelity compare: node apps/web/fidelity/compare.mjs <route> [<route>...]
 *
 * For each prototype route it captures the Control Room prototype and the real app at 1440x900 and 390x844, in light and dark,
 * and writes side-by-side PNGs (prototype left, real right) to
 *   /home/reshif/Downloads/gantry-designs/design-1-control-room/fidelity/<route>-<w>-<theme>.png
 * Routes may carry a parameter (record/WO-1004). `all` runs every mapped route. MAP.md says which real route each one means.
 *
 *  - prototype: python3 -m http.server 9401 from the prototype folder
 *  - real app : `vite build` of apps/web, then `vite preview` on 9510; every /api and /auth call is answered by page.route with
 *               apps/web/e2e/fixtures.ts (the admin persona) plus apps/web/e2e/rich.ts (a loaded plant), no live stack
 * Flags: --skip-build (reuse apps/web/dist), --only=1440|390, --theme=light|dark, --full (grow the window to the whole page, default on)
 * Servers and the browser are started here and stopped by PID when the run ends.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const PROTO = "/home/reshif/Downloads/gantry-designs/design-1-control-room";
const OUT = join(PROTO, "fidelity");
const PW = "/home/reshif/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const PROTO_PORT = 9401;
const REAL_PORT = 9510;
const NOW = Date.parse("2026-01-15T10:00:00Z");

/** prototype route -> real hash (the same table, in prose, is apps/web/fidelity/MAP.md) */
const P = "/#/p/payments";
export const ROUTE_MAP = {
  home: "/#home", inbox: "/#inbox", workspace: "/#workspace", console: "/#workspace", conversations: `${P}/conversations`, projects: "/#projects",
  floor: `${P}/floor`, "work-orders": `${P}/work-orders`, record: `${P}/record/WO-1004`, traveler: `${P}/record/WO-1004?traveler=WO-1004`, dossier: `${P}/record/WO-1004`, changes: `${P}/changes/WO-1004`,
  onboarding: `${P}/onboarding`, "project-config": `${P}/project-config`,
  agents: "/#agents", skills: "/#skills", models: "/#models", evals: "/#evals", trust: "/#trust", learning: "/#learning",
  integrations: "/#integrations", mcp: "/#mcp", api: "/#api", notifications: "/#notifications",
  people: "/#people", workload: "/#workload", access: "/#access", security: "/#security", audit: "/#audit", system: "/#system", signin: "/", "design-system": "/#design-system",
};
const realHash = (route) => {
  const [name, param] = route.split("/");
  const base = ROUTE_MAP[name];
  if (base === undefined) throw new Error(`no mapping for route "${name}" (see ROUTE_MAP)`);
  if (base === null) return null;
  return param && !base.includes("WO-") ? `${base}/${param}` : base;
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
let routes = args.filter((a) => !a.startsWith("--"));
if (!routes.length) { console.error("usage: node compare.mjs <route> [<route>...]   (or: all)"); process.exit(2); }
if (routes.includes("all")) routes = Object.keys(ROUTE_MAP).filter((r) => ROUTE_MAP[r]);

const pids = [];
const run = (cmd, argv, opts = {}) => { const c = spawn(cmd, argv, { stdio: ["ignore", "ignore", "ignore"], detached: true, ...opts }); pids.push(c.pid); return c; };
const stopAll = () => { for (const pid of pids) { try { process.kill(-pid); } catch { /* already gone */ } } }; // each server is its own process group (npx spawns children)
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopAll(); process.exit(130); });

async function up(url, tries = 120) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); }
  return false;
}
const exec = (cmd, argv, cwd) => new Promise((res, rej) => { const c = spawn(cmd, argv, { cwd, stdio: "inherit" }); c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${argv.join(" ")} exited ${code}`)))); });

async function main() {
  mkdirSync(OUT, { recursive: true });
  // 1. the rich fixtures are TypeScript: bundle them once with esbuild (they import e2e/fixtures.ts and the domain catalogue)
  const esbuild = await import(join(WEB, "..", "..", "node_modules", "esbuild", "lib", "main.js")).then((m) => m.default ?? m);
  await esbuild.build({ entryPoints: [join(WEB, "e2e", "rich.ts")], bundle: true, platform: "node", format: "esm", outfile: join(HERE, ".build", "rich.mjs"), external: ["@playwright/test", "@gantry/domain"], logLevel: "error" });
  // @gantry/domain resolves from the repo; @playwright/test is only used for its types and a test object that is never run
  const rich = await import(join(HERE, ".build", "rich.mjs"));

  // 2. the real app, built and previewed
  if (!flags["skip-build"]) await exec("npx", ["vite", "build", "--logLevel", "error"], WEB);
  if (!(await up(`http://127.0.0.1:${PROTO_PORT}/index.html`, 2))) run("python3", ["-m", "http.server", String(PROTO_PORT), "--bind", "127.0.0.1"], { cwd: PROTO });
  if (!(await up(`http://127.0.0.1:${REAL_PORT}/`, 2))) run("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(REAL_PORT), "--strictPort"], { cwd: WEB });
  if (!(await up(`http://127.0.0.1:${PROTO_PORT}/index.html`)) || !(await up(`http://127.0.0.1:${REAL_PORT}/`))) throw new Error("servers did not start");

  // 3. one browser
  const { chromium } = await import(PW);
  // Playwright's headless shell may not be installed; a full Chromium from the cache works the same (newest first).
  const cache = join(homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const exe = process.env.GANTRY_E2E_CHROMIUM ?? dirs.map((d) => join(cache, d, "chrome-linux64", "chrome")).find((p) => existsSync(p));
  const browser = await chromium.launch(exe ? { executablePath: exe, args: ["--no-sandbox"] } : {});

  const SIZES = [[1440, 900], [390, 844]].filter(([w]) => !flags.only || String(w) === String(flags.only));
  const THEMES = ["light", "dark"].filter((t) => !flags.theme || t === flags.theme);
  const made = [];
  const shot = async (page, w, h) => {
    // let the app settle, then grow the window to the whole scrolling region so the PNG shows the entire page
    await page.waitForTimeout(700);
    const need = await page.evaluate(() => { const m = document.querySelector("#main") ?? document.scrollingElement; return (m?.scrollHeight ?? 0) + (document.querySelector("#statusbar, .sbar")?.clientHeight ?? 0) + (document.querySelector("#topbar, .top")?.clientHeight ?? 0); });
    const H = Math.min(4200, Math.max(h, need));
    if (H !== h) { await page.setViewportSize({ width: w, height: H }); await page.waitForTimeout(300); }
    return page.screenshot({ type: "png" });
  };

  for (const route of routes) {
    const real = realHash(route);
    for (const [w, h] of SIZES) {
      for (const theme of THEMES) {
        const common = { viewport: { width: w, height: h }, colorScheme: theme, locale: "en-US", timezoneId: "UTC", hasTouch: w < 500 };
        // prototype
        const pc = await browser.newContext(common);
        await pc.addInitScript((t) => { try { localStorage.setItem("gcr.theme", JSON.stringify(t)); } catch { /* ignore */ } }, theme);
        const pp = await pc.newPage();
        await pp.goto(`http://127.0.0.1:${PROTO_PORT}/index.html#/${route}`);
        await pp.waitForSelector("#main > *");
        const left = await shot(pp, w, h);
        await pc.close();
        // real
        let right;
        const rc = await browser.newContext(common);
        await rc.addInitScript(([t, nowMs]) => { try { localStorage.setItem("gantry.prefs", JSON.stringify({ theme: t, project: "payments", recentProjects: ["payments"], pinnedProjects: [], navRail: false })); } catch { /* ignore */ } void nowMs; }, [theme, NOW]);
        const rp = await rc.newPage();
        await rp.clock.install({ time: new Date(NOW) });
        await rich.installRich(rp);
        if (real === null) {
          right = await rp.screenshot({ type: "png" }); // the real app has no equivalent screen (see MAP.md)
        } else {
          await rp.goto(`http://127.0.0.1:${REAL_PORT}${real}`);
          await rp.waitForSelector("#root > *");
          await rp.waitForLoadState("networkidle");
          right = await shot(rp, w, h);
        }
        await rc.close();
        // side by side: prototype left, real right
        const cc = await browser.newContext({ viewport: { width: 2 * w + 12, height: 400 } });
        const cp = await cc.newPage();
        await cp.setContent(`<body style="margin:0;background:#888;display:flex;gap:12px;align-items:flex-start"><img id="a" src="data:image/png;base64,${left.toString("base64")}"><img id="b" src="data:image/png;base64,${right.toString("base64")}"></body>`);
        await cp.waitForFunction(() => [...document.images].every((i) => i.complete));
        const file = join(OUT, `${route.replace(/\//g, "_")}-${w}-${theme}.png`);
        await cp.screenshot({ path: file, fullPage: true });
        await cc.close();
        made.push(file);
        console.log(file);
      }
    }
  }
  await browser.close();
  return made;
}

main().then(() => { stopAll(); process.exit(0); }, (e) => { console.error(e); stopAll(); process.exit(1); });
