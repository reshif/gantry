// TEST ONLY: shared helpers for the wave 4 end-to-end scripts (Playwright through https://localhost and Keycloak, API calls as the signed-in person).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the local ingress uses a private CA; this is a test client
import { execFileSync } from "node:child_process";
import { DIR, PSQL, loadPlaywright, chromeOptions } from "./paths.mjs";
const { chromium } = await loadPlaywright();

export { DIR, PSQL };
export const PROJECT = process.env.E2E_PROJECT ?? "w4e2e";
export const q = (sql) => execFileSync(PSQL, ["-tA", "-F", "|", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("|"));
export const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts }).trim();
export const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PEOPLE = { arjun: "Arjun Mehta", asha: "Asha Raman", chloe: "Chloe Martin", daniel: "Daniel Okafor", fatima: "Fatima Zahra", grace: "Grace Liu", hana: "Hana Sato", kenji: "Kenji Watanabe", meera: "Meera Iyer", omar: "Omar Haddad", priya: "Priya Nair", rui: "Rui Costa", sam: "Sam Whitfield", tomas: "Tomás Ferreira" };

export const results = [];
export function check(name, ok, detail = "") { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + String(detail).replace(/\s+/g, " ").slice(0, 260) + ")" : ""}`); return !!ok; }
export const summary = () => { const f = results.filter((r) => !r.ok); console.log(`\n${results.length - f.length}/${results.length} passed${f.length ? "; FAILED: " + f.map((r) => r.name).join("; ") : ""}`); };

let browser;
export async function launch() { browser ??= await chromium.launch(chromeOptions()); return browser; }
export async function close() { await browser?.close(); browser = undefined; }

/** Signs in through Keycloak as a seeded person and returns { ctx, page, api }. api(method, path, body, headers) calls https://localhost with the session cookie and CSRF token. */
export async function session(user) {
  const b = await launch();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("https://localhost/", { waitUntil: "networkidle" });
  if (await page.getByText(PEOPLE[user], { exact: true }).count()) await page.getByText(PEOPLE[user], { exact: true }).first().click();
  else { await page.getByText("Continue with SSO").first().click(); await page.waitForSelector("#username, input[name=username]"); await page.fill("#username, input[name=username]", user); }
  const next = await Promise.race([page.waitForSelector("input[name=password], #password", { timeout: 15000 }).then(() => "kc"), page.waitForSelector("#nav a.nav-link", { state: "attached", timeout: 15000 }).then(() => "in")]).catch(() => "in");
  if (next === "kc") {
    await page.fill("input[name=password], #password", "gantry-dev");
    await page.click("#kc-login, input[type=submit], button[type=submit]");
  }
  await page.waitForSelector("#nav a.nav-link", { state: "attached", timeout: 30000 });
  const me = await (await ctx.request.get("https://localhost/api/v1/me")).json();
  const csrf = me.csrf ?? me.session?.csrf;
  const api = async (method, path, body, headers = {}) => {
    const r = await ctx.request.fetch(`https://localhost${path}`, { method, headers: { "x-csrf-token": csrf, "content-type": "application/json", origin: "https://localhost", ...headers }, data: body === undefined ? undefined : JSON.stringify(body), failOnStatusCode: false });
    let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status(), body: j };
  };
  return { ctx, page, api, user, me };
}

/** A plain request with an API key (no session). */
export async function keyApi(key, method, path, body, headers = {}) {
  const r = await fetch(`https://localhost${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), dispatcher: undefined }).catch((e) => ({ status: 0, text: async () => String(e) }));
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
export const fakeState = () => JSON.parse(sh("docker", ["exec", `${PROJECT}-fake-github-1`, "node", "-e", "require('https').get('https://127.0.0.1:8090/_fake/state',{rejectUnauthorized:false},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(b))})"]));
export const fakeSet = (obj) => sh("docker", ["exec", `${PROJECT}-fake-github-1`, "node", "-e", `const b=${JSON.stringify(JSON.stringify(obj))};const rq=require('https').request('https://127.0.0.1:8090/_fake/set',{method:'POST',rejectUnauthorized:false,headers:{'content-type':'application/json'}},r=>{r.resume();r.on('end',()=>console.log('ok'))});rq.end(b)`]);
export const doubles = (path, body) => sh("docker", ["exec", `${PROJECT}-fake-saas-1`, "node", "-e", `const b=${JSON.stringify(body === undefined ? null : JSON.stringify(body))};const rq=require('http').request('http://127.0.0.1:80${path}',{method:b?'POST':'GET',headers:{'content-type':'application/json'}},r=>{let o='';r.on('data',d=>o+=d);r.on('end',()=>console.log(o))});rq.end(b||undefined)`]);
export async function until(what, fn, ms = 120000, every = 1500) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(every); } }
/** Restarts the fake GitHub (a clean repository with no PRs, rulesets or onboarding files). */
export async function resetFakeGithub() {
  sh(`${DIR}/dc.sh`, ["up", "-d", "--no-build", "--force-recreate", "--no-deps", "fake-github"]);
  await until("fake github healthy", () => { try { fakeState(); return true; } catch { return false; } }, 60000, 1500);
}
