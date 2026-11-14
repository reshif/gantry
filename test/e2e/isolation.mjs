// TEST ONLY: spec 5.4 T5-T8 against a real launcher-created runner on the compose stack. Submits a work order through the real UI so the worker dispatches a real runner,
// then probes from inside the runner (docker exec) and, for T7, from the control network after the run is stopped. Usage: node isolation.mjs
import { execFileSync } from "node:child_process";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
const PSQL = "/tmp/claude-0/w3e2e/psql.sh";
const q = (sql) => execFileSync(PSQL, ["-tA", "-F", "|", "-c", sql], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("|"));
const sh = (c, a, o = {}) => { try { return execFileSync(c, a, { encoding: "utf8", ...o }).trim(); } catch (e) { return `ERR ${String(e.stdout ?? "")}${String(e.stderr ?? "")}`.trim(); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const out = {};
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("https://localhost/", { waitUntil: "networkidle" });
await page.getByText("Asha Raman", { exact: true }).first().click();
await page.waitForSelector("input[name=password], #password");
await page.fill("input[name=password], #password", "gantry-dev");
await page.click("#kc-login, input[type=submit], button[type=submit]");
await page.waitForSelector("text=Jump to or run", { timeout: 30000 });
await page.goto("https://localhost/#floor"); await page.waitForTimeout(1800);
await page.getByRole("button", { name: /New work order/ }).click();
await page.selectOption("#nwo-repo", { label: "acme/payments-api" });
await page.fill("#nwo-title", "Bump a dependency for the isolation probe");
await page.fill("#nwo-desc", "Probe.");
await page.click("#nwo-submit");
await page.waitForSelector("text=Answer intake questions");
const id = (await page.locator("[role=dialog] h2, [role=dialog] h1").first().innerText()).match(/WO-\d+/)[0];
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Answer intake questions/ }).click();
await page.waitForTimeout(1200);
if (!(await page.locator(`#conv-confirm-${id}`).count())) { await page.locator(`text=${id}`).first().click(); await page.waitForTimeout(800); }
for (const a of ["Only this repo", "It builds.", "Revert.", "Next patch."]) {
  if ((await page.locator(`#conv-confirm-${id}`).getAttribute("aria-disabled")) !== "true") break;
  await page.locator("textarea").last().fill(a); await page.getByRole("button", { name: /^Send$/ }).click(); await page.waitForTimeout(900);
}
await page.locator(`#conv-confirm-${id}`).click();
log("submitted and confirmed", id);
let runId = null;
for (let i = 0; i < 90 && !runId; i++) {
  const r = q(`select r.id from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id where a.wo_id = '${id}' and a.state = 'running' order by r.created_at desc limit 1`)[0];
  if (r && sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${r[0]}`])) runId = r[0];
  else await sleep(1000);
}
if (!runId) throw new Error("no runner");
const C = `gantry-runner-${runId}`;
await sleep(2000);
log("runner", C);

// ---- T5: nothing secret in the environment or filesystem ------------------------------------------------------------
const t5 = `
const fs=require("fs"),path=require("path");
const found=[];
const bad=/(ghs_|ghp_|gho_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20}|-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16})/;
for(const [k,v] of Object.entries(process.env)){ if(bad.test(v)) found.push("env "+k); if(/(KEY|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(k)) found.push("envname "+k); }
const sock=["/var/run/docker.sock","/run/docker.sock","/docker.sock"].filter(p=>fs.existsSync(p));
const secretsDir=["/run/secrets","/var/run/secrets","/secrets"].filter(p=>fs.existsSync(p));
let scanned=0;
function walk(d,depth){ if(depth>6) return; let es; try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}
  for(const e of es){ const p=path.join(d,e.name); if(["/proc","/sys","/dev"].includes(p)) continue;
    if(e.isDirectory()) walk(p,depth+1); else if(e.isFile()){ try{ const st=fs.statSync(p); if(st.size>2e6) continue; const t=fs.readFileSync(p,"utf8"); scanned++; if(bad.test(t) && !p.includes("/node_modules/")) found.push("file "+p);}catch{} } } }
for(const d of ["/workspace","/tmp","/home","/run","/etc","/opt/gantry-wrapper/dist","/root","/var"]) walk(d,0);
const gantryEnv=Object.keys(process.env).filter(k=>k.startsWith("GANTRY")||k.endsWith("_PROXY")||k==="EDGE_URL");
console.log(JSON.stringify({found,sock,secretsDir,scanned,gantryEnv}));`;
out.T5 = JSON.parse(sh("docker", ["exec", C, "node", "-e", t5]));
log("T5", JSON.stringify(out.T5));

// ---- T6: writes outside /workspace and /tmp fail ------------------------------------------------------------------------
const t6 = `
const fs=require("fs");const r={};
for(const p of ["/etc/t6","/usr/t6","/opt/t6","/var/t6","/t6","/home/t6","/run/t6","/bin/t6","/proc/t6","/opt/gantry-wrapper/t6"]){ try{fs.writeFileSync(p,"x");r[p]="WROTE";fs.unlinkSync(p)}catch(e){r[p]=e.code} }
for(const p of ["/workspace/t6","/tmp/t6"]){ try{fs.writeFileSync(p,"x");r[p]="ok";fs.unlinkSync(p)}catch(e){r[p]=e.code} }
console.log(JSON.stringify(r));`;
out.T6 = JSON.parse(sh("docker", ["exec", C, "node", "-e", t6]));
log("T6", JSON.stringify(out.T6));

// ---- T8: package host off the allow-list through the edge proxy ---------------------------------------------------------
const t8 = `
const net=require("net");
const tok=process.env.GANTRY_RUN_TOKEN;
function connect(host,port,auth){return new Promise(res=>{const s=net.connect({host:"gantry-edge",port:8444,timeout:8000});let d="";s.on("connect",()=>s.write("CONNECT "+host+":"+port+" HTTP/1.1\\r\\nHost: "+host+":"+port+"\\r\\n"+(auth?"Proxy-Authorization: Basic "+Buffer.from("run:"+tok).toString("base64")+"\\r\\n":"")+"\\r\\n"));s.on("data",x=>{d+=x;s.destroy()});s.on("close",()=>res(d.split("\\r\\n")[0]||"closed"));s.on("error",e=>res("error "+e.code));s.on("timeout",()=>{s.destroy();res("timeout")});});}
(async()=>{const r={};
 r.evil=await connect("pypi.evil.example",443,true);
 r.evilNoCreds=await connect("pypi.evil.example",443,false);
 r.privateAddr=await connect("169.254.169.254",80,true);
 r.edgeInternal=await connect("gantry-api",8000,true);
 r.npm=await connect("registry.npmjs.org",443,true);
 console.log(JSON.stringify(r));})()`;
out.T8 = JSON.parse(sh("docker", ["exec", C, "node", "-e", t8]));
log("T8", JSON.stringify(out.T8));

// ---- T7: capture the token, stop the run, call the edge with the token ----------------------------------------------------
const token = sh("docker", ["exec", C, "sh", "-c", "printf %s \"$GANTRY_RUN_TOKEN\""]);
const callsFor = (withResult) => `
const tok=${JSON.stringify(token)}, id=${JSON.stringify(runId)};
(async()=>{const r={};
 const h={authorization:"Bearer "+tok,"x-gantry-run-id":id};
 const f=async(k,u,o={})=>{try{const x=await fetch("http://gantry-edge:8443"+u,{...o,headers:{...h,...(o.headers||{})},signal:AbortSignal.timeout(5000)});r[k]=x.status}catch(e){r[k]="error "+e.message}};
 await f("spec","/run/v1/spec");
 await f("heartbeat","/run/v1/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
 ${withResult ? `await f("result","/run/v1/result",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({runId:id,at:new Date().toISOString(),status:"succeeded",output:{},usage:[],adapter:"stub",capabilities:{cancel:true,resume:false,mcp:false,usageDetail:false}})});` : ""}
 await f("model","/model/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"x",max_tokens:1,messages:[{role:"user",content:"hi"}]})});
 console.log(JSON.stringify(r));})()`;
const live = JSON.parse(sh("docker", ["exec", C, "node", "-e", callsFor(false)]));
log("T7 before stop (from the runner, run live)", JSON.stringify(live));
// stop: kill the work order through the UI
await page.goto("https://localhost/#work-orders"); await page.waitForTimeout(2000);
await page.getByText(id, { exact: true }).first().click(); await page.waitForTimeout(1500);
await page.locator("#trv-kill").click(); await page.waitForSelector("#kill-reason");
await page.fill("#kill-reason", "T7: stop the run, then replay its token");
if (await page.locator("#kill-confirm").count()) await page.fill("#kill-confirm", await page.locator("#kill-confirm").getAttribute("placeholder"));
await page.click("#kill-ok");
for (let i = 0; i < 60 && sh("docker", ["ps", "-q", "--filter", `name=${C}`]); i++) await sleep(250);
log("runner removed:", !sh("docker", ["ps", "-aq", "--filter", `name=${C}`]));
const net = (await sh("docker", ["network", "ls", "--format", "{{.Name}}", "--filter", "name=w3e2e_control"])).trim();
const after = JSON.parse(sh("docker", ["run", "--rm", "--network", net, "--entrypoint", "node", "node:22-alpine", "-e", callsFor(true)]));
out.T7 = { liveBeforeStop: live, afterStopFromControlNet: after };
log("T7 after stop", JSON.stringify(after));
// T8 logging: the edge reports refusals once a minute
await sleep(65000);
out.T8.logged = q("select type, after from events where type like 'egress.%' order by seq desc limit 5").map((r) => r.join(" ").slice(0, 200));
log("T8 audit", JSON.stringify(out.T8.logged));
console.log("RESULTS " + JSON.stringify(out));
await browser.close();
