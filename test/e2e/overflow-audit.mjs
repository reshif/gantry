// TEST ONLY: browser audit of overflow/scroll problems across every nav screen, project page and overlay (dialogs, drawers, popovers, menus, palette).
// Read-only: every non-GET /api request is aborted (except POST /api/v1/can, the read-only permission check), so nothing is created, approved, killed or sent. Usage: node overflow-audit.mjs <WxH> [user] [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHOTS, ensureDir } from "./paths.mjs";
import { session, close, sleep } from "./lib4.mjs";
import { devSeed } from "../../packages/domain/dist/seed.js";
import { route as routeOf, routeGates } from "../../packages/domain/dist/flow.js";

const [W, H] = (process.argv[2] ?? "1366x768").split("x").map(Number);
const USER = process.argv[3] ?? "asha";
const OUT = process.argv[4] ?? ensureDir(join(SHOTS, "overflow"));
const PROJECT = "nautobot-jobs";
mkdirSync(OUT, { recursive: true });
const DENY = /sign out|log out|switch user/i;

/** Runs in the page. Returns problems for the given roots (or the main view). */
const MEASURE = (mode) => {
  const iw = window.innerWidth, ih = window.innerHeight, out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"; };
  const name = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}${(e.textContent || "").trim().slice(0, 24) ? ` "${(e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24)}"` : ""}`;
  const scrollable = (a) => { const cs = getComputedStyle(a); const oy = cs.overflowY; if (a === document.documentElement || a === document.body) return oy !== "hidden" && oy !== "clip" && document.scrollingElement.scrollHeight > ih + 1; return (oy === "auto" || oy === "scroll") && a.scrollHeight > a.clientHeight + 1; };
  const hiddenY = (a) => { const oy = getComputedStyle(a).overflowY; return oy === "hidden" || oy === "clip"; };
  let roots;
  if (mode === "overlay") roots = [...document.querySelectorAll(".dlg,.drawer,.pop,[role=menu],[role=listbox],[role=dialog]")].filter(vis).filter((e) => !(e.closest("#main") && !e.matches(".dlg,.drawer,.pop") && !["fixed", "absolute"].includes(getComputedStyle(e).position))).filter((e, i, all) => !all.some((o) => o !== e && o.contains(e)));
  else roots = [document.querySelector("#view, main, .main") ?? document.body];
  for (const root of roots) {
    const rr = root.getBoundingClientRect();
    const tag = name(root).slice(0, 40);
    if (mode === "overlay") {
      if (rr.left < -1 || rr.top < -1 || rr.right > iw + 1 || rr.bottom > ih + 1) {
        let reach = false; for (let a = root.parentElement; a; a = a.parentElement) if (scrollable(a) && getComputedStyle(a).position !== "static") { reach = true; break; }
        const isDlg = root.classList.contains("dlg"); const foot = root.querySelector(".dlg-foot");
        if (!isDlg || (foot && foot.getBoundingClientRect().bottom > ih + 1) || rr.right > iw + 1 || rr.left < -1) out.push(`overlay ${tag} outside viewport (${Math.round(rr.left)},${Math.round(rr.top)} -> ${Math.round(rr.right)},${Math.round(rr.bottom)} vs ${iw}x${ih})${reach ? " (page-scroll reachable)" : ""}`);
      }
      if (root.classList.contains("dlg")) { const f = root.querySelector(".dlg-foot"); if (f && f.getBoundingClientRect().bottom > ih + 1) out.push(`dialog footer not visible without scrolling (bottom ${Math.round(f.getBoundingClientRect().bottom)} > ${ih})`); }
    }
    const els = [root, ...root.querySelectorAll("*")].slice(0, 4000);
    let n = 0;
    for (const e of els) {
      if (n > 12) break;
      const r = e.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const cs = getComputedStyle(e);
      if (cs.position === "fixed" || cs.visibility === "hidden" || cs.display === "none") continue;
      if (e.closest(".sr-only,.visually-hidden,svg,[aria-hidden=true],.tip,.toast-wrap,.toasts")) continue;
      // clipped by an overflow-hidden ancestor whose box ends before this element does
      for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ac = getComputedStyle(a);
        if (ac.position === "fixed") break;
        if (hiddenY(a)) { const ar = a.getBoundingClientRect(); if (ar.height > 1 && r.bottom > ar.bottom + 3 && r.top < ar.bottom && cs.position !== "absolute" && ac.display !== "contents") { out.push(`clipped by overflow-hidden ${name(a)}: ${name(e)} extends ${Math.round(r.bottom - ar.bottom)}px past it`); n++; } break; }
        if (scrollable(a) && a !== document.body && a !== document.documentElement) break;
      }
      // below the fold with no scrollable ancestor (and not clipped by overflow hidden on html/body)
      if (r.bottom > ih + 2 && r.top < ih && mode === "overlay") {
        let ok = false; for (let a = e.parentElement; a; a = a.parentElement) if (scrollable(a)) { ok = true; break; }
        if (!ok) { out.push(`unreachable below fold: ${name(e)} bottom ${Math.round(r.bottom)} > ${ih}`); n++; }
      }
    }
  }
  if (mode === "page") {
    const se = document.scrollingElement;
    if (se.scrollWidth > iw + 1) out.push(`horizontal page overflow: scrollWidth ${se.scrollWidth} > ${iw}`);
    // the content must be reachable: some element scrolls, or the document does
    const view = roots[0];
    const last = [...view.querySelectorAll("*")].filter((e) => vis(e) && getComputedStyle(e).position !== "fixed").map((e) => e.getBoundingClientRect().bottom).sort((a, b) => b - a)[0] ?? 0;
    if (last > ih + 2) { let ok = false; for (let a = view; a; a = a.parentElement) if (scrollable(a)) { ok = true; break; } if (!ok) out.push(`page content bottom ${Math.round(last)} > ${ih} but nothing scrolls`); }
    // fixed/sticky bars eating the viewport
    let bars = 0; for (const e of document.querySelectorAll("*")) { const cs = getComputedStyle(e); if ((cs.position === "fixed" || cs.position === "sticky") && vis(e)) { const r = e.getBoundingClientRect(); if (r.top <= 2 && r.width > iw * 0.5 && r.height < ih) bars += r.height; } }
    if (bars > ih * 0.3) out.push(`sticky/fixed top bars take ${Math.round(bars)}px of ${ih}px`);
  }
  const se = document.scrollingElement; if (se.scrollWidth > iw + 1 && mode === "overlay") out.push(`horizontal page overflow with overlay open: ${se.scrollWidth} > ${iw}`);
  return [...new Set(out)];
};

const results = [];
let shot = 0;
const s = await session(USER);
const page = s.page;
await page.setViewportSize({ width: W, height: H });
await page.route("**/api/**", (route) => (route.request().method() === "GET" || route.request().method() === "HEAD" || /\/api\/v1\/can$/.test(route.request().url()) ? route.continue() : route.abort()));
// The live org is empty, so GET responses are patched IN THE BROWSER ONLY (nothing is written anywhere): repos report Ready and the demo seed's work orders
// are shown for the project, so dialogs and drawers that need data (New work order, gates, stations, traveler, kill/restore) can be opened.
const SEED = devSeed();
const MOCK_WOS = SEED.state.workOrders.map((w) => ({ ...w, project: PROJECT, allowed: {}, route: routeOf(SEED.catalog, null, w.cls), gates: routeGates(SEED.catalog, null, w.cls) }));
const patchJson = async (route, fn) => { const r = await route.fetch(); let b; try { b = await r.json(); } catch { return route.fulfill({ response: r }); } return route.fulfill({ response: r, json: fn(b) }); };
let repoId = null;
await page.route(`**/api/v1/projects/${PROJECT}/repos`, (route) => patchJson(route, (b) => { for (const r of b) { repoId ??= r.id; r.onboarding = { ...r.onboarding, stage: "ready" }; } return b; }));
const wosFor = () => MOCK_WOS.map((w) => ({ ...w, repo: repoId ?? w.repo }));
await page.route(`**/api/v1/projects/${PROJECT}/floor*`, (route) => patchJson(route, (b) => ({ ...b, workOrders: wosFor() })));
await page.route(new RegExp(`/api/v1/projects/${PROJECT}/work-orders(\\?.*)?$`), (route) => { const u = new URL(route.request().url()); const st = u.searchParams.get("state"); const items = wosFor().filter((w) => !st || st === "all" || (st === "open" ? !["done", "killed"].includes(w.state) : w.state === st)); return route.fulfill({ json: { items: items.slice(0, Number(u.searchParams.get("limit") ?? 60)), next: null, total: items.length } }); });
await page.route(/\/api\/v1\/work-orders\/WO-[0-9]+$/, (route) => { const id = route.request().url().split("/").pop(); const w = wosFor().find((x) => x.id === id); return w ? route.fulfill({ json: w }) : route.continue(); });
// AUDIT_BREAK=1 re-creates the original bug (a % max-height, no scrolling) to prove the audit can see it.
if (process.env.AUDIT_BREAK) await page.addInitScript(() => { const add = () => { const st = document.createElement("style"); st.textContent = ".dlg{max-height:none!important}.dlg-body{overflow:visible!important}.dlg-wrap{overflow:visible!important}.drawer{overflow:hidden!important}"; document.head.appendChild(st); }; if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add(); });
page.on("pageerror", (e) => console.log(`   PAGEERROR ${String(e.message).slice(0, 200)}`));
page.on("dialog", (d) => d.dismiss().catch(() => {}));
const vpName = `${W}x${H}`;
const record = async (where, problems) => {
  const ok = problems.length === 0;
  results.push({ vp: vpName, where, problems });
  if (!ok) { const f = `${OUT}/${vpName}-${String(++shot).padStart(3, "0")}-${where.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png`; await page.screenshot({ path: f }).catch(() => {}); console.log(`FAIL ${vpName} ${where}\n   ${problems.join("\n   ")}\n   -> ${f}`); } else console.log(`ok   ${vpName} ${where}`);
};
const overlayPresent = () => page.evaluate(() => [...document.querySelectorAll(".dlg,.drawer,.pop,[role=menu],[role=listbox]")].some((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && !(e.closest("#main") && !e.matches(".dlg,.drawer,.pop") && !["fixed", "absolute"].includes(getComputedStyle(e).position)); }));
const closeOverlays = async (url) => {
  for (let i = 0; i < 4 && (await overlayPresent()); i++) { await page.keyboard.press("Escape"); await sleep(150); }
  if (await overlayPresent()) { await page.locator(".scrim, .pop-shield").first().click({ timeout: 800, force: true }).catch(() => {}); await sleep(150); }
  if (await overlayPresent()) { await page.goto(url); await sleep(1500); }
};
const lockState = () => page.evaluate(() => ({ b: getComputedStyle(document.body).overflow, h: getComputedStyle(document.documentElement).overflow }));

const FACTORY = ["home", "projects", "console", "agents", "skills", "models", "evals", "trust", "learning", "integrations", "notifications", "mcp", "api", "people", "workload", "access", "security", "audit"];
const PROJ = ["floor", "work-orders", "conversations", "onboarding", "project-config"];
await page.goto(`https://localhost/#/p/${PROJECT}/floor`); await sleep(2500);
const navHrefs = await page.$$eval("#nav a.nav-link", (as) => as.map((a) => a.getAttribute("href")));
const pages = [...new Set([...FACTORY.map((i) => `#${i}`), ...PROJ.map((i) => `#/p/${PROJECT}/${i}`), ...navHrefs])];
// extra routes not in the nav
await s.api("GET", `/api/v1/work-orders?limit=1`).catch(() => null);
const woId = MOCK_WOS.find((w) => w.state === "running")?.id ?? MOCK_WOS[0]?.id;
if (woId) pages.push(`#/p/${PROJECT}/record/${woId}`, `#/p/${PROJECT}/traveler/${woId}`);
console.log(`${vpName}: ${pages.length} pages`, woId ? `wo ${woId}` : "");

const MAIN = '#main button:visible, #main [role=button]:visible, #main [aria-haspopup]:visible, #main summary:visible, #main tbody tr:visible, #main [tabindex="0"]:visible';
const SHELL = '#topbar button:visible, #nav button:visible, .stop-banner button:visible';
const LIMITS = [[/^WO-#/, 3], [/Open audit entry/, 2], [/^(Remove|Move) /, 2], [/^(Open|Edit|Delete|Invite|Put)/, 3]];
const labelsOf = (sel) => page.locator(sel).evaluateAll((es) => es.map((e, i) => ({ i, tag: e.tagName, cls: String(e.className).slice(0, 30), label: (e.getAttribute("aria-label") || e.textContent || e.title || "").trim().replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 40) })));
/** Clicks every distinct clickable matched by sel once (by label, re-queried each time so navigation and re-renders cannot skip any), measuring each overlay. */
async function crawl(sel, url, where, tabIx, cap = 60) {
  const done = new Set(); const counts = new Map(); let clicks = 0;
  const reopen = async () => { await page.goto("about:blank"); await page.goto(url); await sleep(2200); if (tabIx >= 0) { await page.locator("[role=tab]:visible").nth(tabIx).click({ timeout: 1500 }).catch(() => {}); await sleep(500); } };
  while (clicks < cap) {
    const list = await labelsOf(sel).catch(() => []);
    const next = list.find((x) => {
      if (DENY.test(x.label) || !x.label && x.tag !== "TR") return false;
      const key = `${x.tag}|${x.tag === "TR" ? "" : x.label}|${x.cls}`; if (done.has(key)) return false;
      const lim = LIMITS.find(([re]) => re.test(x.label)); if (lim) { const k = String(lim[0]); if ((counts.get(k) ?? 0) >= lim[1]) { done.add(key); return false; } }
      if (x.tag === "TR" && (counts.get("TR") ?? 0) >= 2) return false;
      return true;
    });
    if (!next) { if (process.env.DEBUG_AUDIT) await page.screenshot({ path: `${OUT}/dbg-${++shot}.png` }); if (process.env.DEBUG_AUDIT) console.log(`   (no more: url ${page.url()} ${list.length} candidates ${JSON.stringify(list.map((x) => x.label))}, done ${[...done].join(";")})`); break; }
    const key = `${next.tag}|${next.tag === "TR" ? "" : next.label}|${next.cls}`; done.add(key);
    const lim = LIMITS.find(([re]) => re.test(next.label)); if (lim) counts.set(String(lim[0]), (counts.get(String(lim[0])) ?? 0) + 1); if (next.tag === "TR") counts.set("TR", (counts.get("TR") ?? 0) + 1);
    const h = page.locator(sel).nth(next.i);
    try { await h.scrollIntoViewIfNeeded({ timeout: 800 }); await h.click({ timeout: 1200 }); } catch { continue; }
    clicks++; await sleep(350);
    if (!(await overlayPresent())) { if (page.url() !== url) await reopen(); continue; }
    const name = `${where} > ${next.label || next.cls}`;
    for (let step = 0; step < 7; step++) {
      await record(`${name} [step ${step}]`, await page.evaluate(MEASURE, "overlay"));
      const nx = page.locator(".dlg button:not([disabled])").filter({ hasText: /^(Next|Continue|Review|Choose|Pick|Select|Use this|Start)/i }).first();
      if (!(await nx.count())) break;
      for (const inp of await page.locator('.dlg input[type=text]:visible, .dlg input:not([type]):visible, .dlg textarea:visible').all()) { if (!(await inp.inputValue().catch(() => "x"))) await inp.fill("audit").catch(() => {}); }
      await nx.click({ timeout: 800 }).catch(() => {}); await sleep(350);
      if (!(await overlayPresent())) break;
    }
    // second-level: a drawer or dialog with its own buttons (tabs inside a drawer, menu items) is walked one level deep
    await closeOverlays(url);
    const lk = await lockState();
    if (lk.b !== base.b || lk.h !== base.h) await record(`${name} (scroll lock after close)`, [`body/html overflow ${base.b}/${base.h} -> ${lk.b}/${lk.h}`]);
    if (page.url() !== url) await reopen();
  }
  console.log(`   ${where}: ${clicks} clickables exercised`);
}
let base = { b: "", h: "" };
let firstPage = true;
for (const href of pages.filter((h) => !process.env.ONLY || new RegExp(process.env.ONLY).test(h))) {
  const url = `https://localhost/${href}`;
  await page.goto("about:blank"); await page.goto(url); await sleep(2800);
  await closeOverlays(url);
  base = await lockState();
  await record(`page ${href}`, await page.evaluate(MEASURE, "page"));
  if (firstPage) {
    firstPage = false;
    await page.keyboard.press("Control+k"); await sleep(400);
    await record("palette Ctrl K", await page.evaluate(MEASURE, "overlay"));
    await page.keyboard.type("a"); await sleep(300);
    await record("palette Ctrl K (typed)", await page.evaluate(MEASURE, "overlay"));
    await closeOverlays(url);
    // shell: project switcher, status chip, bell, user menu (and the dialogs it opens), nav toggle
    await crawl(SHELL, url, "shell", -1, 20);
    for (const item of ["Profile", "My roles per project", "My sessions"]) {
      await page.getByRole("button", { name: /Account menu/ }).click().catch(() => {}); await sleep(300);
      await page.getByRole("menuitem", { name: item }).click({ timeout: 1000 }).catch(() => {}); await sleep(400);
      if (await overlayPresent()) await record(`user menu > ${item}`, await page.evaluate(MEASURE, "overlay"));
      await closeOverlays(url);
    }
    await page.goto("about:blank"); await page.goto(url); await sleep(2500);
  }
  const tabs = await page.locator("[role=tab]:visible").count();
  for (const tabIx of [-1, ...Array.from({ length: Math.min(tabs, 10) }, (_, i) => i)]) {
    if (tabIx >= 0) { await page.locator("[role=tab]:visible").nth(tabIx).click({ timeout: 1500 }).catch(() => {}); await sleep(600); await record(`page ${href} [tab ${tabIx}]`, await page.evaluate(MEASURE, "page")); }
    await crawl(MAIN, url, `${href}${tabIx >= 0 ? ` tab ${tabIx}` : ""}`, tabIx, 60);
  }
}
// icon-rail flyouts: hover every nav item
await page.goto(`https://localhost/#/p/${PROJECT}/floor`); await sleep(2500);
for (const a of await page.locator("#nav a.nav-link:visible").elementHandles()) { await a.hover({ timeout: 800 }).catch(() => {}); await sleep(250); if (await overlayPresent()) await record(`nav hover flyout`, await page.evaluate(MEASURE, "overlay")); }
writeFileSync(`${OUT}/results-${vpName}.json`, JSON.stringify(results, null, 1));
const bad = results.filter((r) => r.problems.length);
console.log(`\n${vpName}: ${results.length} measurements, ${bad.length} with problems`);
await close();
