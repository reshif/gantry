// TEST ONLY: walks every nav screen through the real browser as a Factory Admin and as an Engineer, screenshots each, and reports console errors,
// failed API calls (status >= 400 on /api/), and placeholder text. Usage: node walk.mjs [asha arjun ...]
import { session, close, log, sleep } from "./lib4.mjs";

const users = process.argv.slice(2).length ? process.argv.slice(2) : ["asha", "tomas"];
const PLACEHOLDER = /Ported in a later wave|coming soon|not yet ported|TODO|lorem ipsum|placeholder screen/i;
const out = [];
for (const user of users) {
  const s = await session(user);
  const page = s.page;
  const errors = []; const api = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { const u = r.url(); if (u.includes("/api/v1/") && r.status() >= 400 && !u.endsWith("/can")) api.push(`${r.status()} ${r.request().method()} ${u.replace("https://localhost", "")}`); });
  await page.goto("https://localhost/#home"); await sleep(2500);
  const ids = await page.$$eval("#nav a.nav-link", (as) => as.map((a) => a.getAttribute("href").slice(1).replace(/^\/p\/[^/]+\//, "")));
  log(`${user}: nav has ${ids.length} screens: ${ids.join(", ")}`);
  for (const id of ids) {
    errors.length = 0; api.length = 0;
    await page.goto(`https://localhost/#${id}`); await sleep(3200);
    const text = await page.evaluate(() => (document.querySelector("main, #main, .main, #view") ?? document.body).innerText);
    const file = `/tmp/claude-0/w4e2e-screen-${user === "asha" ? "" : "eng-"}${id}.png`;
    await page.screenshot({ path: file, fullPage: false });
    const ph = PLACEHOLDER.exec(text)?.[0] ?? null;
    const row = { user, id, chars: text.length, placeholder: ph, errors: [...errors], api: [...api], file };
    out.push(row);
    console.log(`${row.errors.length || row.api.length || ph || text.length < 40 ? "WARN" : "ok  "} ${user} #${id} chars=${text.length}${ph ? " PLACEHOLDER=" + ph : ""}${row.errors.length ? " errors=" + JSON.stringify(row.errors) : ""}${row.api.length ? " api=" + JSON.stringify(row.api) : ""}`);
  }
  // the work order record screen (reachable from the traveler, not listed in the nav)
  await page.evaluate(async () => { const r = await fetch("/api/v1/work-orders?limit=1"); return r.status; }).catch(() => 0);
  await s.ctx.close();
}
await close();
const bad = out.filter((r) => r.errors.length || r.api.length || r.placeholder || r.chars < 40);
console.log(`\n${out.length} screens walked; ${bad.length} with findings`);
