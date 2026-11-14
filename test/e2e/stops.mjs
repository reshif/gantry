// TEST ONLY: halt and kill a run mid-flight through the real UI and measure spec 4.4 (edge refusal within 10 s, container gone within 60 s).
// Usage: node stops.mjs [tag]. Needs agent-double.mjs running with long delays (/tmp/claude-0/w3e2e/delays.json {"default":180000,"build":180000}).
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const TAG = process.argv[2] ?? "s";
const PSQL = "/tmp/claude-0/w3e2e/psql.sh";
const q = (sql) => execFileSync(PSQL, ["-tA", "-F", "|", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("|"));
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: "utf8" }).trim(); } catch { return ""; } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
let n = 0;
const shot = (page, name) => page.screenshot({ path: `/tmp/claude-0/w3e2e-${TAG}-${String(++n).padStart(2, "0")}-${name}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("response", async (r) => { if (r.url().includes("/api/v1/") && r.request().method() !== "GET" && !r.url().endsWith("/can")) log("[api]", r.request().method(), r.url().replace("https://localhost", ""), r.status(), (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)); });
await page.goto("https://localhost/", { waitUntil: "networkidle" });
await page.getByText("Asha Raman", { exact: true }).first().click();
await page.waitForSelector("input[name=password], #password");
await page.fill("input[name=password], #password", "gantry-dev");
await page.click("#kc-login, input[type=submit], button[type=submit]");
await page.waitForSelector("text=Jump to or run", { timeout: 30000 });

async function submit(title) {
  await page.goto("https://localhost/#floor"); await page.waitForTimeout(1800);
  await page.getByRole("button", { name: /New work order/ }).click();
  await page.selectOption("#nwo-repo", { label: "acme/payments-api" });
  await page.fill("#nwo-title", title);
  await page.fill("#nwo-desc", "Upgrade the helper. Acceptance: it builds.");
  await page.click("#nwo-submit");
  await page.waitForSelector("text=Answer intake questions");
  const id = (await page.locator("[role=dialog] h2, [role=dialog] h1").first().innerText()).match(/WO-\d+/)[0];
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /Answer intake questions/ }).click();
  await page.waitForTimeout(1200);
  if (!(await page.locator(`#conv-confirm-${id}`).count())) { await page.locator(`text=${id}`).first().click(); await page.waitForTimeout(800); }
  for (const a of ["Only this repo", "It builds.", "Revert.", "Next patch.", "None.", "Nothing else."]) {
    if ((await page.locator(`#conv-confirm-${id}`).getAttribute("aria-disabled")) !== "true") break; // brief is ready: stop answering
    await page.locator("textarea").last().fill(a); await page.getByRole("button", { name: /^Send$/ }).click(); await page.waitForTimeout(900);
  }
  await page.locator(`#conv-confirm-${id}`).click();
  await page.waitForTimeout(1500);
  return id;
}
const runOf = (wo) => q(`select r.id, r.state from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id where a.wo_id = '${wo}' and a.state in ('running','queued') order by r.created_at desc limit 1`)[0];
async function untilRunning(wo) {
  for (let i = 0; i < 120; i++) {
    const r = runOf(wo);
    if (r && sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${r[0]}`])) { await sleep(1500); return r[0]; }
    await sleep(1000);
  }
  throw new Error("no running container for " + wo);
}
/** Probes the edge from inside the runner container with its own token every 250 ms; resolves {status log}. */
function probe(runId) {
  const code = `const t=process.env.GANTRY_RUN_TOKEN,id=process.env.GANTRY_RUN_ID,u=process.env.EDGE_URL;(async()=>{for(;;){let st;try{const r=await fetch(u+'/run/v1/spec',{headers:{authorization:'Bearer '+t,'x-gantry-run-id':id},signal:AbortSignal.timeout(3000)});st=r.status}catch(e){st='err'}console.log(Date.now()+' '+st);await new Promise(r=>setTimeout(r,250))}})()`;
  const p = spawn("docker", ["exec", `gantry-runner-${runId}`, "node", "-e", code]);
  const rows = [];
  p.stdout.on("data", (d) => { for (const l of String(d).trim().split("\n")) { const [t, s] = l.split(" "); rows.push([Number(t), s]); } });
  return { rows, stop: () => p.kill() };
}
async function measure(label, runIds, t0) {
  const probes = Object.fromEntries(runIds.map((r) => [r, null]));
  // refusal time: first non-200 status after t0 (the probes were started before)
  const out = {};
  for (let i = 0; i < 300; i++) {
    for (const r of runIds) {
      if (out[r]?.gone) continue;
      out[r] ??= {};
      const pr = P[r];
      if (out[r].refusedMs === undefined) { const f = pr.rows.find(([t, s]) => t >= t0 && s !== "200"); if (f) out[r].refusedMs = f[0] - t0; }
      const up = sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${r}`]);
      if (!up) { out[r].gone = true; out[r].goneMs = Date.now() - t0; }
    }
    if (runIds.every((r) => out[r]?.gone)) break;
    await sleep(200);
  }
  for (const r of runIds) {
    for (let k = 0; k < 120 && sh("docker", ["network", "ls", "-q", "--filter", `name=run-${r}`]); k++) await sleep(500);
    out[r].networkGone = !sh("docker", ["network", "ls", "-q", "--filter", `name=run-${r}`]);
    out[r].networkGoneMs = Date.now() - t0;
    out[r].lastProbe = P[r].rows.at(-1)?.[1];
    P[r].stop();
  }
  results[label] = out;
  log("MEASURED", label, JSON.stringify(out));
}
const P = {};
async function openWo(wo) { await page.goto("https://localhost/#work-orders"); await page.waitForTimeout(2200); await page.getByText(wo, { exact: true }).first().click(); await page.waitForTimeout(1500); }

// ---- two work orders at Plan, both with a long-running stub ---------------------------------------------------------
const woA = await submit("Bump the dependency for halt test A");
const woB = await submit("Bump the dependency for kill test B");
log("submitted", woA, woB);
const runA = await untilRunning(woA), runB = await untilRunning(woB);
P[runA] = probe(runA); P[runB] = probe(runB);
await sleep(1500);
log("both running", runA, runB, "baseline probe", P[runA].rows.at(-1), P[runB].rows.at(-1));
await page.goto("https://localhost/#floor"); await page.waitForTimeout(2200);
await shot(page, "two-runs-up");

// ---- HALT the project mid-run ------------------------------------------------------------------------------------------
await page.locator("#floor-andon").click();
await page.getByText("Halt Payments Platform", { exact: false }).first().click();
await page.waitForSelector("#rsn-text");
await page.fill("#rsn-text", "End-to-end halt test: pulling the andon cord mid-run");
await shot(page, "halt-dialog");
const tHalt = Date.now();
await page.click("#rsn-ok");
log("halt clicked at", tHalt);
await page.waitForTimeout(800);
await shot(page, "halt-clicked");
await measure("halt", [runA, runB], tHalt);
await page.waitForTimeout(1500);
await shot(page, "halted-floor");
log("after halt: attempts", JSON.stringify(q(`select id,state,outcome from attempts where wo_id in ('${woA}','${woB}') order by id`)), "wo", JSON.stringify(q(`select id,position,state from work_orders where id in ('${woA}','${woB}')`)), "slots", JSON.stringify(q(`select id,state,wo_id from slots where project_id='payments' order by id`)));
log("stops", JSON.stringify(q(`select id,mode,scope_type,enforced_at is not null from stops where lifted_at is null`)));

// ---- RESUME ------------------------------------------------------------------------------------------------------------
await page.locator("#floor-andon").click();
await page.waitForTimeout(600);
await shot(page, "before-resume");
await page.getByText(/Resume/).first().click();
await page.waitForTimeout(1500);
log("resumed; waiting for fresh runs");
const runA2 = await untilRunning(woA), runB2 = await untilRunning(woB);
log("fresh runs", runA2, runB2, "(old", runA, runB, ")");
results.resume = { freshRunA: runA2 !== runA, freshRunB: runB2 !== runB };
await page.goto("https://localhost/#floor"); await page.waitForTimeout(2000);
await shot(page, "resumed-runs-up");

// ---- KILL work order B mid-run -----------------------------------------------------------------------------------------
P[runB2] = probe(runB2); P[runA2] = probe(runA2);
await sleep(1500);
await openWo(woB);
await page.locator("#trv-kill").click();
await page.waitForSelector("#kill-reason");
await page.fill("#kill-reason", "End-to-end kill test: stop this work order now");
if (await page.locator("#kill-confirm").count()) await page.fill("#kill-confirm", await page.locator("#kill-confirm").getAttribute("placeholder"));
await shot(page, "kill-dialog");
const tKill = Date.now();
await page.click("#kill-ok");
log("kill clicked at", tKill);
await measure("kill", [runB2], tKill);
await page.waitForTimeout(2500);
await shot(page, "killed-floor");
log("after kill: wo", JSON.stringify(q(`select id,position,state from work_orders where id in ('${woA}','${woB}')`)), "A run alive:", !!sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${runA2}`]));
P[runA2].stop();
results.killOtherWorkOrderUnaffected = !!sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${runA2}`]);

// ---- RESTORE B -----------------------------------------------------------------------------------------------------------
await page.keyboard.press("Escape"); await page.waitForTimeout(500);
await openWo(woB);
const rest = page.getByRole("button", { name: /Restore/ }).first();
if (await rest.count()) {
  await rest.click();
  await page.waitForSelector("#rsn-text");
  await page.fill("#rsn-text", "End-to-end: safe to restore");
  await shot(page, "restore-dialog");
  await page.click("#rsn-ok");
  await page.waitForTimeout(3000);
  await shot(page, "restored");
  log("after restore: wo", JSON.stringify(q(`select id,position,state from work_orders where id = '${woB}'`)));
} else { log("no Restore button found"); await shot(page, "no-restore"); }
log("stops table", JSON.stringify(q(`select id,mode,scope_type,lifted_at is not null from stops order by created_at`)));
results.woA = woA; results.woB = woB;
console.log("RESULTS " + JSON.stringify(results));
await browser.close();
