#!/usr/bin/env node
/* global document */
/**
 * Fidelity compare: the Blueprint prototype is the specification; this puts it next to the real app.
 *
 *   node apps/web/fidelity/compare.mjs <route> [<route>...] [--full] [--no-build] [--widths=1440,390] [--themes=light,dark]
 *
 * A route is a prototype hash route without "#/": `home`, `floor`, `record/WO-2399`, `agents/ag-build`. The real route comes
 * from fidelity/routes.json (default: project routes get /p/payments/). Output, prototype left, real right:
 *   /home/reshif/Downloads/gantry-designs/design-3-blueprint/fidelity/<route>-<w>-<theme>.png
 *
 * Prototype: python3 -m http.server 9403 from the design folder. Real app: `vite build` + `vite preview` on 9530 with every
 * /api call answered by e2e/fixtures.ts (mockApi), fed with the prototype's own demo seed (e2e/seed-fixtures.ts), so both
 * sides show the same factory. Fonts are served locally to both sides (no network). One browser, one preview server, one
 * http server, all stopped by PID on exit.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const PROTO_DIR = "/home/reshif/Downloads/gantry-designs/design-3-blueprint";
const OUT_DIR = process.env.FID_OUT || join(PROTO_DIR, "fidelity"); // FID_OUT: per-engineer output folder
const PW = "/home/reshif/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const PROTO_PORT = Number(process.env.FID_PROTO_PORT || 9423); // unique per parallel run
const REAL_PORT = Number(process.env.FID_REAL_PORT || 9532);
const FONTS = join(WEB, "src/assets/fonts");

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.find((a) => a.startsWith(`--${n}=`)) ?? "").split("=")[1] ?? d;
const routes = argv.filter((a) => !a.startsWith("--"));
if (!routes.length) {
  console.error("usage: compare.mjs <route> [<route>...] [--full] [--no-build] [--widths=1440,390] [--themes=light,dark]");
  process.exit(2);
}
const FULL = argv.includes("--full");
const WIDTHS = flag("widths", "1440,390").split(",").map(Number);
const THEMES = flag("themes", "light,dark").split(",");
const SIZE = { 1440: 900, 390: 844 };

const children = [];
const stopAll = () => children.forEach((c) => { try { process.kill(c.pid); } catch { /* gone */ } });
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

const waitUp = async (url, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up: ${url}`);
};

/* ---- route mapping ---- */
const cfg = JSON.parse(readFileSync(join(HERE, "routes.json"), "utf8"));
const realHash = (route) => {
  if (cfg.overrides[route]) return cfg.overrides[route];
  const [name, ...rest] = route.split("/");
  const real = cfg.rename[name] ?? name;
  const tail = [real, ...rest].join("/");
  return cfg.projectRoutes.includes(name) ? `#/p/${cfg.project}/${tail}` : `#/${tail}`;
};

/* ---- the seed (prototype data.js) ---- */
const sandbox = { window: {} };
sandbox.window = sandbox;
vm.runInNewContext(readFileSync(join(PROTO_DIR, "js/data.js"), "utf8"), sandbox);
const SEED = { ...sandbox.SEED, NOW: sandbox.NOW };

/* ---- build the real app, bundle the fixtures ---- */
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
  const p = join(dir, e.name);
  return Math.max(m, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
}, 0);
const distIndex = join(WEB, "dist/index.html");
const stale = !existsSync(distIndex) || statSync(distIndex).mtimeMs < newest(join(WEB, "src"));
if (!argv.includes("--no-build") && stale) {
  console.log("building apps/web ...");
  const b = spawnSync("npx", ["vite", "build"], { cwd: WEB, stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const cache = join(HERE, ".cache");
mkdirSync(cache, { recursive: true });
const { buildSync } = await import(resolve(WEB, "../../node_modules/esbuild/lib/main.js"));
buildSync({
  stdin: { contents: `export { mockApi, fulfillJson } from "../../e2e/fixtures"; export { seedResolver, personaFromSeed } from "../../e2e/seed-fixtures";`, resolveDir: cache, sourcefile: "entry.ts", loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: join(cache, "fixtures.mjs"), banner: { js: "/* eslint-disable */" }, external: ["@playwright/test"], logLevel: "error",
});
const fx = await import(join(cache, "fixtures.mjs") + `?t=${Date.now()}`);

/* ---- servers ---- */
const py = spawn("python3", ["-m", "http.server", String(PROTO_PORT), "--bind", "127.0.0.1"], { cwd: PROTO_DIR, stdio: "ignore" });
children.push(py);
const pv = spawn(resolve(WEB, "../../node_modules/.bin/vite"), ["preview", "--port", String(REAL_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB, stdio: "ignore" });
children.push(pv);
await Promise.all([waitUp(`http://127.0.0.1:${PROTO_PORT}/index.html`), waitUp(`http://127.0.0.1:${REAL_PORT}/`)]);

const { chromium } = await import(PW);
// The npx Playwright wants a newer browser build than the cache holds: use the newest cached one (or GANTRY_E2E_CHROMIUM).
const cacheRoot = join(process.env.HOME ?? "", ".cache/ms-playwright");
const cached = existsSync(cacheRoot) ? readdirSync(cacheRoot).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
const executablePath = process.env.GANTRY_E2E_CHROMIUM ?? (cached[0] ? join(cacheRoot, cached[0], "chrome-headless-shell-linux64/chrome-headless-shell") : undefined);
const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
const FONT_CSS = [["Space Grotesk", "space-grotesk-latin-wght-normal.woff2", "300 700"], ["JetBrains Mono", "jetbrains-mono-latin-wght-normal.woff2", "100 800"]]
  .map(([f, file, w]) => `@font-face{font-family:"${f}";font-weight:${w};font-display:block;src:url(http://127.0.0.1:${PROTO_PORT}/__fonts/${file}) format("woff2")}`).join("\n");

async function freeze(page) {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
}

async function shoot(kind, route, w, theme) {
  const h = SIZE[w] ?? 900;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: "reduce", hasTouch: w < 500 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.warn(`[${kind} ${route} pageerror] ${String(e.message).split("\n")[0]}`));
  page.on("console", (m) => m.type() === "error" && kind === "real" && console.warn(`[real ${route} console] ${m.text().slice(0, 600)}`));
  try {
    if (kind === "proto") {
      await page.route("**/*", async (r) => {
        const u = new URL(r.request().url());
        if (u.hostname === "fonts.googleapis.com") return r.fulfill({ contentType: "text/css", body: FONT_CSS });
        if (u.pathname.startsWith("/__fonts/")) return r.fulfill({ contentType: "font/woff2", body: readFileSync(join(FONTS, u.pathname.slice(9))) });
        if (u.hostname === "127.0.0.1") return r.continue();
        return r.abort();
      });
      const name = route.split("/")[0];
      const project = cfg.projectRoutes.includes(name) ? cfg.project : "all";
      await page.addInitScript(([t, p]) => { try { localStorage.setItem("gantry-bp", JSON.stringify({ theme: t, project: p, persona: "admin", signedIn: true })); } catch { /* */ } }, [theme, project]);
      await page.goto(`http://127.0.0.1:${PROTO_PORT}/index.html#/${route}`);
      await page.waitForSelector("#app > *");
    } else {
      await fx.mockApi(page, { persona: fx.personaFromSeed(SEED), resolve: fx.seedResolver(SEED) });
      await page.clock.install({ time: new Date(SEED.NOW) });
      await page.addInitScript(([t, p]) => { try { localStorage.setItem("gantry.prefs", JSON.stringify({ theme: t, project: p })); } catch { /* */ } }, [theme, cfg.project]);
      await page.goto(`http://127.0.0.1:${REAL_PORT}/${realHash(route)}`);
      await page.waitForSelector("#root > *");
      await page.waitForLoadState("networkidle");
    }
    await page.waitForTimeout(700);
    await freeze(page);
    if (FULL) {
      const hh = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll("main, .main, .content")].map((e) => e.scrollHeight)));
      await page.setViewportSize({ width: w, height: Math.min(Math.max(hh, h), 3200) });
      await page.waitForTimeout(300);
    }
    return await page.screenshot();
  } finally {
    await ctx.close();
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const sheet = await browser.newContext({ viewport: { width: 1000, height: 600 } });
const written = [];
try {
  for (const route of routes) {
    for (const w of WIDTHS) {
      for (const theme of THEMES) {
        const [a, b] = [await shoot("proto", route, w, theme), await shoot("real", route, w, theme)];
        const p = await sheet.newPage();
        const img = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
        await p.setContent(`<body style="margin:0;background:#888;font:600 14px system-ui"><div style="display:flex;gap:12px;padding:8px;align-items:flex-start">
          <div><div style="color:#fff;padding:4px 0">PROTOTYPE  #/${route}</div><img style="display:block" src="${img(a)}"></div>
          <div><div style="color:#fff;padding:4px 0">REAL  ${realHash(route)}</div><img style="display:block" src="${img(b)}"></div></div></body>`);
        await p.waitForLoadState("load");
        const file = join(OUT_DIR, `${route.replace(/\//g, "_")}-${w}-${theme}.png`);
        writeFileSync(file, await p.screenshot({ fullPage: true }));
        await p.close();
        written.push(file);
        console.log(file);
      }
    }
  }
} finally {
  await sheet.close();
  await browser.close();
  stopAll();
}
