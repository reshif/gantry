// Dev tool: evaluates the legacy frontend data layer (legacy/js) under a fixed clock and a stubbed window.
// Used only by gen-seed.mjs to produce src/seed.data.ts. Not part of the package build.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../../legacy/js");
export const ANCHOR = Date.parse("2026-11-13T06:30:00Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(ANCHOR); else super(...a); }
  static now() { return ANCHOR; }
}
const store = {};
const noop = () => {};
const el = new Proxy(function () {}, { get: (_, k) => (k === "style" || k === "classList" || k === "dataset" ? el : el), apply: () => el, set: () => true });
const win = {
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
  addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }),
  document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el, body: el, documentElement: el },
  location: { hash: "" }, history: {}, setTimeout, clearTimeout, setInterval: noop, requestAnimationFrame: noop,
  console, JSON, Math, Object, Array, Promise, Number, String, RegExp, Error, Map, Set, parseInt, parseFloat, isNaN, Date: FixedDate, Intl,
};
win.window = win; win.self = win; win.globalThis = win;
const ctx = vm.createContext(win);
win.navigator = { userAgent: "node" };
const files = ["data", "flow", "lifecycle", "insight", "catalog", "store", "policy", "ui", "sim", "ops3"];
for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f + ".js"), "utf8"), ctx, { filename: f + ".js" });
const G = win.G;
export function loadLegacy() {
  return { G, anchor: ANCHOR };
}
