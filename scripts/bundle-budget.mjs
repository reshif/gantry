#!/usr/bin/env node
// Measured bundle budget with a ratchet. Run after `npm run build -w @gantry/web`.
// Measures what index.html loads eagerly (entry JS and CSS, modulepreloads included), gzip sizes gate; raw sizes are
// informational. Budget file: apps/web/bundle-budget.json. It starts at the measured value and only goes down:
//   node scripts/bundle-budget.mjs           check (fails above the budget, or more than SLACK bytes below it)
//   node scripts/bundle-budget.mjs --init    write the first budget from the current build
//   node scripts/bundle-budget.mjs --update  lower the budget to the current build (refuses to raise it)
// Target after the domain barrel fix: entry JS <= 80 kB gzip (docs: frontend-production-bar.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(ROOT, "apps", "web", "dist");
export const BUDGET_FILE = join(ROOT, "apps", "web", "bundle-budget.json");
/** A build this far under the budget must lock the gain in (run --update). */
export const SLACK = 1024;

/** The asset files index.html loads eagerly, from its script, modulepreload and stylesheet tags. */
export function entryFiles(html) {
  const js = new Set();
  const css = new Set();
  for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
    const href = /(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (!href || /^https?:/.test(href)) continue;
    if (/<link[^>]*rel="stylesheet"/.test(tag)) css.add(href);
    else if (/<script[^>]*type="module"/.test(tag) || /rel="modulepreload"/.test(tag)) js.add(href);
  }
  return { js: [...js], css: [...css] };
}

export function measure(dist = DIST) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const { js, css } = entryFiles(html);
  const size = (files) =>
    files.reduce(
      (t, f) => {
        const buf = readFileSync(join(dist, f.replace(/^\//, "")));
        return { raw: t.raw + buf.length, gzip: t.gzip + gzipSync(buf, { level: 9 }).length };
      },
      { raw: 0, gzip: 0 },
    );
  const j = size(js);
  const c = size(css);
  return { entryJsGzip: j.gzip, entryCssGzip: c.gzip, entryJsRaw: j.raw, entryCssRaw: c.raw };
}

/** Compare a measurement to the budget: { over: [...], under: [...] } (gzip keys only). */
export function check(m, budget, slack = SLACK) {
  const over = [];
  const under = [];
  for (const k of ["entryJsGzip", "entryCssGzip"]) {
    if (m[k] > budget[k]) over.push({ key: k, budget: budget[k], now: m[k] });
    else if (m[k] < budget[k] - slack) under.push({ key: k, budget: budget[k], now: m[k] });
  }
  return { over, under };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("apps/web/dist is missing; run: npm run build -w @gantry/web");
    process.exit(1);
  }
  const m = measure();
  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  console.log(`Entry JS ${kb(m.entryJsGzip)} gzip (${kb(m.entryJsRaw)} raw), entry CSS ${kb(m.entryCssGzip)} gzip (${kb(m.entryCssRaw)} raw)`);
  const write = () => writeFileSync(BUDGET_FILE, JSON.stringify({ note: "Gzip bytes of what index.html loads eagerly. May only go down: node scripts/bundle-budget.mjs --update", entryJsGzip: m.entryJsGzip, entryCssGzip: m.entryCssGzip }, null, 2) + "\n");
  if (arg === "--init") {
    write();
    console.log("budget written");
  } else {
    if (!existsSync(BUDGET_FILE)) {
      console.error("apps/web/bundle-budget.json is missing; run: node scripts/bundle-budget.mjs --init");
      process.exit(1);
    }
    const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
    const { over, under } = check(m, budget);
    const fmt = (d) => `  ${d.key}: budget ${d.budget}, now ${d.now}`;
    if (arg === "--update") {
      if (over.length) {
        console.error("The budget may only go down. Over budget:\n" + over.map(fmt).join("\n"));
        process.exit(1);
      }
      write();
      console.log("budget lowered to the current build");
    } else if (over.length) {
      console.error("Bundle budget exceeded (reduce the entry; do not raise the budget):\n" + over.map(fmt).join("\n"));
      process.exit(1);
    } else if (under.length) {
      console.error("Bundle is smaller than the budget. Lock in the gain: node scripts/bundle-budget.mjs --update\n" + under.map(fmt).join("\n"));
      process.exit(1);
    } else console.log("Bundle budget: ok");
  }
}
