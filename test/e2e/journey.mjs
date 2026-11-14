// TEST ONLY: drives the full work-order journey through the real browser path (Playwright, https://localhost, Keycloak sign-in) against the compose stack.
// Usage: node journey.mjs [tag]   Screenshots go to /tmp/claude-0/w3e2e-<tag>-NN-*.png
import { execFileSync } from "node:child_process";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const TAG = process.argv[2] ?? "j";
const PSQL = "/tmp/claude-0/w3e2e/psql.sh";
const q = (sql) => execFileSync(PSQL, ["-tA", "-F", "|", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("|"));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const fakeState = () => JSON.parse(sh("docker", ["exec", "w3e2e-fake-github-1", "node", "-e", "require('https').get('https://127.0.0.1:8090/_fake/state',{rejectUnauthorized:false},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))})"]));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
let n = 0;
const shot = (page, name) => page.screenshot({ path: `/tmp/claude-0/w3e2e-${TAG}-${String(++n).padStart(2, "0")}-${name}.png` });
const PEOPLE = { asha: "Asha Raman", daniel: "Daniel Okafor", meera: "Meera Iyer", priya: "Priya Nair", sam: "Sam Whitfield", omar: "Omar Haddad", kenji: "Kenji Watanabe", grace: "Grace Liu", hana: "Hana Sato" };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
async function session(user) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("response", async (r) => { if (r.url().includes("/api/v1/") && r.request().method() !== "GET" && !r.url().endsWith("/can")) log(`[${user}]`, r.request().method(), r.url().replace("https://localhost", ""), r.status(), (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 150)); });
  await page.goto("https://localhost/", { waitUntil: "networkidle" });
  await page.getByText(PEOPLE[user], { exact: true }).first().click();
  await page.waitForSelector("input[name=password], #password");
  await page.fill("input[name=password], #password", "gantry-dev");
  await page.click("#kc-login, input[type=submit], button[type=submit]");
  await page.waitForSelector("text=Jump to or run", { timeout: 30000 });
  return { ctx, page };
}
const woState = (id) => q(`select position, state from work_orders where id = '${id}'`)[0] ?? [];
async function until(what, fn, ms = 240000, every = 1500) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await new Promise((r) => setTimeout(r, every)); }
}

// ---- 1. sign in, submit ---------------------------------------------------------------------------------------------
const asha = await session("asha");
let page = asha.page;
await shot(page, "signed-in-home");
await page.goto("https://localhost/#floor"); await page.waitForTimeout(2000);
await shot(page, "floor");
await page.getByRole("button", { name: /New work order/ }).click();
await page.selectOption("#nwo-repo", { label: "acme/payments-api" });
await page.fill("#nwo-title", "Bump the greeting helper dependency in payments-api");
await page.fill("#nwo-desc", "Upgrade the greeting helper and add it under src/. Acceptance: helper exported and the build passes.");
await shot(page, "new-work-order-form");
await page.click("#nwo-submit");
await page.waitForSelector("text=Answer intake questions");
const woId = (await page.locator("[role=dialog] h2, [role=dialog] h1").first().innerText()).match(/WO-\d+/)[0];
log("submitted", woId);
await page.waitForTimeout(600);
await shot(page, "classified");
// ---- 2. answer intake, confirm brief -------------------------------------------------------------------------------
await page.getByRole("button", { name: /Answer intake questions/ }).click();
await page.waitForTimeout(1200);
await shot(page, "intake-conversation");
const answers = ["Only payments-api", "Helper exported from src/ and the build passes.", "Revert the commit.", "Next patch release."];
for (const a of [...answers, "None.", "Nothing else."]) {
  if ((await page.locator(`#conv-confirm-${woId}`).getAttribute("aria-disabled")) !== "true") break; // brief is ready: stop answering
  await page.locator("textarea").last().fill(a);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.waitForTimeout(900);
}
await shot(page, "intake-answered");
await page.locator(`#conv-confirm-${woId}`).click();
await page.waitForTimeout(2000);
await shot(page, "brief-confirmed");
log("brief confirmed", woState(woId));

// ---- 3. walk the route: every human gate is approved by someone other than the author --------------------------------
const CANDIDATES = ["daniel", "meera", "priya", "sam", "omar", "kenji", "grace", "hana"];
let shotsRunning = new Set();
let approvals = 0;
for (let guard = 0; guard < 40; guard++) {
  const [pos, st] = await until("work order to settle", () => { const w = woState(woId); return ["waiting", "done", "failed", "blocked", "parked", "killed"].includes(w[1]) || (w[1] === "running" && false) ? w : null; }, 420000, 1500).catch((e) => { log(e.message); return ["?", "timeout"]; });
  log("settled at", pos, st);
  if (st === "done" || st === "timeout" || st === "failed") break;
  const gate = q(`select gate_id, id from gate_instances where wo_id = '${woId}' and status = 'open'`)[0];
  if (!gate) { log("waiting but no open gate; position", pos); await new Promise((r) => setTimeout(r, 3000)); continue; }
  const [gateId] = gate;
  log("gate open", gateId);
  if (gateId === "G5") {
    const fs = fakeState();
    log("PR on fake before G5 approval:", JSON.stringify(fs.pulls.map((p) => ({ n: p.number, head: p.head, state: p.state, title: p.title }))));
  }
  let done = false;
  for (const user of CANDIDATES) {
    const s = await session(user);
    const p = s.page;
    await p.goto("https://localhost/#work-orders"); await p.waitForTimeout(2200);
    await p.getByText(woId, { exact: true }).first().click();
    await p.waitForTimeout(1500);
    const dis = await p.locator("#trv-approve").getAttribute("aria-disabled").catch(() => "missing");
    if (dis === "true" || dis === "missing") { await s.ctx.close(); continue; }
    await shot(p, `gate-${gateId}-traveler-${user}`);
    await p.locator("#trv-approve").click();
    await p.waitForTimeout(2500);
    await shot(p, `gate-${gateId}-approved`);
    log(`gate ${gateId} approved by ${user}`);
    approvals++;
    await s.ctx.close();
    done = true;
    break;
  }
  if (!done) { log("no candidate could approve", gateId); break; }
  // a moment later, show the floor mid-run for the screenshot
  await new Promise((r) => setTimeout(r, 2500));
  const w = woState(woId);
  if (w[1] === "running" && !shotsRunning.has(w[0])) {
    shotsRunning.add(w[0]);
    await page.goto("https://localhost/#floor"); await page.waitForTimeout(2000);
    await shot(page, `floor-running-${w[0]}`);
    log("containers:", sh("docker", ["ps", "--format", "{{.Names}}", "--filter", "name=gantry-runner-"]));
  }
}
log("final", woState(woId), "approvals", approvals);
const fs = fakeState();
log("fake github pulls:", JSON.stringify(fs.pulls.map((p) => ({ n: p.number, state: p.state, merged: p.merged_at, head: p.head.ref }))));
await page.goto("https://localhost/#floor"); await page.waitForTimeout(2000);
await shot(page, "floor-final");
await page.goto("https://localhost/#work-orders"); await page.waitForTimeout(1800);
await page.getByText(woId, { exact: true }).first().click().catch(() => {});
await page.waitForTimeout(1500);
await shot(page, "traveler-final");
await browser.close();
console.log(JSON.stringify({ woId, final: woState(woId), approvals }));
