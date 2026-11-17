/**
 * Token checks shared by `scripts/check-tokens.mjs` (CLI, CI) and `src/styles/tokens.test.ts`.
 * Pure JS, no dependencies: parses styles/tokens.css into its three theme blocks, resolves var() aliases,
 * computes WCAG contrast for the colour pairs the UI actually uses, and finds undefined var(--x) uses.
 */
import fs from "node:fs";
import path from "node:path";

/** Custom properties that are set at runtime through style props, not in CSS. */
export const RUNTIME_VARS = new Set(["--heat", "--g", "--v"]);

/** [foreground, background, minimum ratio, why]. Text pairs 4.5, non-text 3. */
const TEXT_ON = ["--bg", "--surface", "--panel", "--sunk"];
export const PAIRS = [
  ...["--ink", "--ink-2", "--muted", "--faint"].flatMap((f) => TEXT_ON.map((b) => [f, b, 4.5, "text"])),
  ["--accent", "--surface", 4.5, "accent text"],
  ["--accent", "--accent-soft", 4.5, "accent chip"],
  ["--accent-ink", "--accent", 4.5, "primary button"],
  ["--accent-ink", "--accent-hover", 4.5, "primary button hover"],
  ...["run", "wait", "block", "fail", "done"].flatMap((t) => [
    [`--${t}`, `--${t}-soft`, 4.5, "status chip"],
    [`--${t}`, "--surface", 4.5, "status text"],
  ]),
  ["--surface", "--kill", 4.5, "killed chip"],
  ["--kill", "--kill-soft", 4.5, "kill banner"],
  ["--gate", "--gate-soft", 4.5, "gate chip"],
  ...["feature", "bug", "hotfix", "epic", "chore", "refactor", "security", "docs", "spike"].map((c) => [`--cls-${c}`, "--surface", 4.5, "work class"]),
  ["--accent", "--surface", 3, "focus ring"],
];

const BLOCKS = [
  ["light", /^:root\s*\{/m],
  ["dark-media", /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{/],
  ["dark-attr", /:root\[data-theme="dark"\]\s*\{/],
];

function blockBody(src, re) {
  const m = re.exec(src);
  if (!m) throw new Error(`tokens.css: block ${re} not found`);
  let i = m.index + m[0].length;
  const start = i;
  let depth = 1;
  while (i < src.length && depth) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

export function declarations(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().replace(/\s+/g, " ");
  return out;
}

export function parseThemes(src) {
  const raw = Object.fromEntries(BLOCKS.map(([n, re]) => [n, declarations(blockBody(src, re))]));
  return {
    raw,
    light: raw.light,
    darkMedia: { ...raw.light, ...raw["dark-media"] },
    darkAttr: { ...raw.light, ...raw["dark-attr"] },
  };
}

export function resolve(vars, name, depth = 0) {
  const v = vars[name];
  if (v === undefined || depth > 10) return undefined;
  const m = /^var\((--[\w-]+)\)$/.exec(v);
  return m ? resolve(vars, m[1], depth + 1) : v;
}

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function ratio(a, b) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every failing pair in every theme. A pair whose tokens do not resolve to hex is reported as unresolved. */
export function contrastFailures(src) {
  const t = parseThemes(src);
  const fails = [];
  for (const [theme, vars] of [["light", t.light], ["dark-media", t.darkMedia], ["dark-attr", t.darkAttr]]) {
    for (const [fg, bg, min, why] of PAIRS) {
      const r = ratio(resolve(vars, fg), resolve(vars, bg));
      if (r === null) fails.push({ theme, fg, bg, ratio: 0, min, why, unresolved: true });
      else if (r < min) fails.push({ theme, fg, bg, ratio: Math.round(r * 100) / 100, min, why });
    }
  }
  return fails;
}

/** The two dark blocks must declare exactly the same properties and values. */
export function darkBlocksDiff(src) {
  const { raw } = parseThemes(src);
  const a = raw["dark-media"];
  const b = raw["dark-attr"];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** var(--x) uses (CSS and TS) whose property is declared nowhere in the CSS and is not a runtime-set variable. */
export function undefinedVars(srcDir) {
  const files = walk(srcDir);
  const defined = new Set();
  for (const f of files.filter((x) => x.endsWith(".css"))) for (const m of fs.readFileSync(f, "utf8").matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const bad = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!defined.has(m[1]) && !RUNTIME_VARS.has(m[1])) bad.push({ file: path.relative(srcDir, f), name: m[1] });
    }
  }
  return bad;
}

export function runChecks(srcDir) {
  const src = fs.readFileSync(path.join(srcDir, "styles", "tokens.css"), "utf8");
  return { contrast: contrastFailures(src), darkDiff: darkBlocksDiff(src), undefinedVars: undefinedVars(srcDir) };
}
