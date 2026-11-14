// TEST ONLY: M6 acceptance against the compose stack (real browser sign-in, public API, runner containers, edge).
// Usage: node m6.mjs [budget|model|learning|trust|workload|console ...]   (no argument: all)
// Needs agent-double.mjs running (stub adapter with long delays) for the budget section.
import { randomUUID } from "node:crypto";
import { session, close, log, q, sleep, until, sh, check, summary, PSQL, DIR } from "./lib4.mjs";
import { execFileSync, spawnSync } from "node:child_process";

const idem = () => ({ "idempotency-key": randomUUID() });
const wanted = process.argv.slice(2);
const want = (n) => !wanted.length || wanted.includes(n);
const sql = (s) => execFileSync(PSQL, ["-tA", "-c", s], { encoding: "utf8" }).trim();
const asha = await session("asha");
const PROJECT = process.env.E2E_PROJECT ?? "w4e2e";

async function newWo(title) {
  const r = await asha.api("POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title, description: "Add a helper under src/. Acceptance: exported and builds." }, idem());
  const wo = r.body.id;
  const answers = ["Only payments-api", "Helper exported from src/ and the build passes.", "Revert the commit.", "Next patch release.", "None.", "Nothing else.", "No other constraints.", "That is all."];
  const done = async () => (await asha.api("GET", `/api/v1/work-orders/${wo}`)).body?.conv?.done === true;
  for (const a of answers) { if (await done()) break; await asha.api("POST", `/api/v1/work-orders/${wo}/messages`, { text: a }, idem()); await sleep(1000); }
  await until("brief complete", done, 30000, 1500);
  return wo;
}
const runningRun = (wo) => q(`select r.id from runs r join attempts a on a.org_id = r.org_id and a.id = r.attempt_id where a.wo_id = '${wo}' and r.state in ('starting','running') order by r.created_at desc limit 1`)[0]?.[0];
const containerUp = (id) => !!sh("docker", ["ps", "-q", "--filter", `name=gantry-runner-${id}`]);
const inRunner = (id, code) => { const r = spawnSync("docker", ["exec", `gantry-runner-${id}`, "node", "-e", code], { encoding: "utf8" }); return (r.stdout + r.stderr).trim(); };
/** What the edge does after a model call: reports usage to the API, with the edge's own service token (test harness acting as the edge). */
function edgeUsage(runId, token, o) {
  const code = `const fs=require('fs');const t=fs.readFileSync('/run/secrets/edge_token','utf8').trim();fetch('http://gantry-api:8000/internal/v1/runs/${runId}/usage',{method:'POST',headers:{authorization:'Bearer '+t,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ token, requestId: randomUUID(), ...o })})}).then(async r=>console.log(r.status+' '+await r.text()))`;
  const r = spawnSync("docker", ["exec", `${PROJECT}-gantry-edge-1`, "node", "-e", code], { encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}
const edgeProbe = (runId, path = "/run/v1/spec") => inRunner(runId, `const t=process.env.GANTRY_RUN_TOKEN,id=process.env.GANTRY_RUN_ID,u=process.env.EDGE_URL;fetch(u+'${path}',{headers:{authorization:'Bearer '+t,'x-gantry-run-id':id},signal:AbortSignal.timeout(5000)}).then(async r=>console.log(r.status+' '+(await r.text()).slice(0,200)),e=>console.log('err '+e.message))`);

async function budget() {
  log("== budget: breach halts at a turn boundary and resumes");
  let r = await asha.api("PUT", "/api/v1/budgets/payments", { perWorkOrder: 0.5 });
  check("budget: a per-work-order cap of $0.50 is set", r.status === 200, `${r.status} ${r.body.msg}`);
  const wo = await newWo("Budget breach acceptance");
  r = await asha.api("POST", `/api/v1/work-orders/${wo}/confirm-brief`, {});
  check("budget: the brief is confirmed and the work order starts", r.status === 200, `${r.status} ${r.body.msg}`);
  const run = await until("a runner container", () => { const id = runningRun(wo); return id && containerUp(id) ? id : null; }, 120000, 1500);
  await sleep(1500);
  const token = inRunner(run, "console.log(process.env.GANTRY_RUN_TOKEN)");
  check("budget: a live run with its own token", token.length > 20, `run ${run}`);
  check("budget: under the cap the edge serves the run (spec call 200)", edgeProbe(run).startsWith("200"), edgeProbe(run).slice(0, 80));
  const u = edgeUsage(run, token, { model: "claude-sonnet-5-5", vendor: "anthropic", inputTokens: 5000, outputTokens: 400000, latencyMs: 900 });
  check("budget: the edge reports a call whose cost is over the cap", u.startsWith("200"), u.slice(0, 200));
  const stop = await until("a budget halt", () => q(`select id, mode, cause from stops where wo_id = '${wo}' and lifted_at is null order by created_at desc limit 1`)[0], 20000, 1000).catch(() => null);
  check("budget: a system halt with cause 'budget' is set on that work order only", !!stop && stop[1] === "halt" && /budget/.test(stop[2] ?? ""), JSON.stringify(stop));
  const t0 = Date.now();
  const after = edgeProbe(run);
  check("budget: the edge refuses the run's next call straight away (turn boundary, no in-flight kill)", /^(409|403|402)/.test(after), after.slice(0, 160));
  await until("run torn down after the grace", () => !containerUp(run), 90000, 1500);
  check("budget: the run is stopped and torn down within the halt grace", true, `${Math.round((Date.now() - t0) / 1000)} s after the first refusal`);
  const st = q(`select state from work_orders where id='${wo}'`)[0]?.[0];
  const slot = q(`select count(*) from stops where wo_id='${wo}' and cause like '%budget%'`)[0]?.[0];
  check("budget: the work order is halted, not failed, and the halt is audited", st !== "failed" && q(`select count(*) from events where type='stop.set' and after::text like '%budget%'`)[0][0] > "0", `state=${st}`);
  const other = q(`select count(*) from stops where cause like '%budget%' and wo_id is distinct from '${wo}' and lifted_at is null`)[0][0];
  check("budget: no other work order or project was stopped", other === "0", `others=${other}`);
  // an operator raises the cap and resumes
  await asha.api("PUT", "/api/v1/budgets/payments", { perWorkOrder: 50 });
  const res = await asha.api("DELETE", `/api/v1/stops/workorder:${wo}`, {});
  check("budget: after raising the cap, resume lifts the halt", res.status === 200, `${res.status} ${res.body.msg}`);
  const run2 = await until("a fresh run", () => { const id = runningRun(wo); return id && id !== run && containerUp(id) ? id : null; }, 120000, 1500);
  check("budget: the work order resumes with a fresh run (new run id, new token)", run2 !== run, `${run} -> ${run2}`);
  check("budget: the fresh run is served by the edge", edgeProbe(run2).startsWith("200"), edgeProbe(run2).slice(0, 80));
  await asha.api("PUT", "/api/v1/budgets/payments", { perWorkOrder: 0 });
  return wo;
}

async function model() {
  log("== model: a new agent version with a new model id is blocked until its suite passes");
  const get = async () => (await asha.api("GET", "/api/v1/agents")).body.find((x) => x.id === "ag-build");
  let ag = await get();
  const live = q(`select live_version from agents where id='ag-build'`)[0][0];
  const label = "9." + Math.floor(Date.now() / 1000 % 1000) + ".0";
  let r = await asha.api("PATCH", "/api/v1/agents/ag-build", { patch: { model: "claude-haiku-5-5" }, note: "Try Haiku for the builder" }, { "if-match": String(ag.rev) });
  check("model: the working copy's model id is changed (Opus to Haiku)", r.status === 200 && (await get()).model === "claude-haiku-5-5", `${r.status} ${r.body.msg}`);
  r = await asha.api("POST", "/api/v1/agents/ag-build/versions", { label, note: "Builder on Haiku" }, idem());
  check("model: a candidate version is snapshotted", r.status === 200, `${r.status} ${r.body.msg}`);
  ag = await get();
  const elig = ag.versions.find((v) => v.v === label)?.eligibility;
  check("model: the candidate is reported not eligible (no suite run yet)", elig && elig.ok === false, JSON.stringify(elig));
  r = await asha.api("POST", `/api/v1/agents/ag-build/versions/${label}/promote`, {}, { "if-match": String(ag.rev) });
  check("model: promotion is refused by the eval gate (403 EVAL-GATE) before any suite run", r.status === 403 && r.body.rule?.id === "EVAL-GATE", `${r.status} ${r.body.rule?.id} ${r.body.msg}`);
  check("model: the live version is unchanged and the denial is audited", q(`select live_version from agents where id='ag-build'`)[0][0] === live && q(`select count(*) from events where type='agent.edit.denied' and rule='EVAL-GATE'`)[0][0] > "0", `live=${live}`);
  const suite = ag.suite ?? "SUITE-BUILD";
  r = await asha.api("POST", `/api/v1/suites/${suite}/runs`, { agent: "ag-build", version: label, repeats: 1 }, idem());
  check("model: the suite is run against the candidate", r.status === 200, `${r.status} ${r.body.msg}`);
  const runId = /RUN-\d+/.exec(r.body.msg ?? "")?.[0] ?? r.body.run?.id ?? r.body.id;
  const done = await until("eval run completed", async () => { const x = (await asha.api("GET", `/api/v1/suites/${suite}/runs`)).body.find?.((y) => y.id === runId); return x && ["completed", "failed", "cancelled"].includes(x.status ?? x.state) ? x : null; }, 300000, 4000).catch((e) => ({ status: e.message }));
  check("model: the suite run finishes", done.status === "completed", JSON.stringify({ id: runId, status: done.status, score: done.score, passed: done.passed, count: done.count, model: done.model }));
  log("eval run", JSON.stringify(done).slice(0, 300));
  ag = await get();
  const e2 = ag.versions.find((v) => v.v === label)?.eligibility;
  r = await asha.api("POST", `/api/v1/agents/ag-build/versions/${label}/promote`, {}, { "if-match": String(ag.rev) });
  const consistent = e2?.ok ? r.status === 200 : r.status === 403;
  check("model: after the run, promotion follows the suite result (eligible: promoted; below threshold: still blocked)", consistent, `eligibility=${JSON.stringify(e2)} promote=${r.status} ${r.body.msg}`);
  // put the working copy back so nothing leaks into later checks
  ag = await get();
  if (r.status !== 200) await asha.api("PATCH", "/api/v1/agents/ag-build", { patch: { model: "claude-opus-5-5" }, note: "Back to Opus" }, { "if-match": String(ag.rev) });
}

async function learning() {
  log("== learning: a proposal applies only on acceptance");
  const omar = await session("omar");
  const skill = async () => (await asha.api("GET", "/api/v1/skills")).body.find((x) => x.id === "sk-testdesign");
  let fs = (await asha.api("GET", "/api/v1/learning/findings")).body; if (!fs.length) { await asha.api("POST", "/api/v1/learning/findings/refresh", {}); fs = (await asha.api("GET", "/api/v1/learning/findings")).body; }
  const fid = fs.find((f) => f.status === "open")?.id;
  check("learning: findings come from real signals (eval regression, intake misses)", !!fid, JSON.stringify(fs.map((f) => f.id + ":" + f.signal)));
  const sk0 = await skill();
  const st = (await asha.api("GET", "/api/v1/learning/settings")).body;
  check("learning: proposals are off in a new install", st.proposalsOn === false, JSON.stringify(st));
  const draft = (who, over = {}) => who.api("POST", "/api/v1/learning/proposals", { finding: fid, kind: "skill", title: "Test design: state the rollback", expected: "Fewer missing-rollback misses", change: { skill: "sk-testdesign", after: `${sk0.body} Always state how the change is rolled back.` }, metric: { target: 0 }, windowDays: 7, ...over }, idem());
  let r = await draft(asha);
  check("learning: drafting is refused while the switch is off (403 LEARN-SWITCH, audited)", r.status === 403 && r.body.rule?.id === "LEARN-SWITCH" && q(`select count(*) from events where type='learning.apply.denied'`)[0][0] > "0", `${r.status} ${r.body.rule?.id}`);
  r = await asha.api("PUT", "/api/v1/learning/switch", { on: true, reason: "Acceptance run of the learning loop" });
  check("learning: an admin turns proposals on with a reason", r.status === 200, `${r.status} ${r.body.msg}`);
  r = await draft(asha);
  const pid = r.body.proposal?.id;
  check("learning: a proposal is drafted with its metric and window", r.status === 200 && !!pid && r.body.proposal.status === "proposed", `${r.status} ${r.body.msg}`);
  check("learning: a draft changes nothing (the skill text is untouched)", (await skill()).body === sk0.body && (await skill()).versions.length === sk0.versions.length, "");
  r = await asha.api("POST", `/api/v1/learning/proposals/${pid}/accept`, { note: "own draft" });
  check("learning: the drafter cannot accept it (403 LEARN-TWO-PERSON)", r.status === 403 && r.body.rule?.id === "LEARN-TWO-PERSON", `${r.status} ${r.body.rule?.id}`);
  check("learning: still unchanged after the refused accept", (await skill()).body === sk0.body, "");
  r = await omar.api("POST", `/api/v1/learning/proposals/${pid}/accept`, { note: "Reviewed, applies" });
  const sk1 = await skill();
  check("learning: a second person accepts and the change applies through the ordinary skill command", r.status === 200 && sk1.body.includes("Always state how the change is rolled back.") && sk1.versions.length === sk0.versions.length + 1, `${r.status} ${r.body.msg}`);
  check("learning: it is audited twice (skill.edit and learning apply) and carries a baseline and rollback", q(`select count(*) from events where type='skill.edit' and actor='p-omar'`)[0][0] > "0" && q(`select count(*) from events where type like 'learning.%' and subject->>'id'='${pid}'`)[0][0] > "0", "");
  const rb = await omar.api("POST", `/api/v1/learning/proposals/${pid}/rollback`, { reason: "Acceptance run cleanup" });
  check("learning: rollback restores the previous text (as a new version)", rb.status === 200 && (await skill()).body === sk0.body, `${rb.status} ${rb.body.msg}`);
  const d2 = await draft(asha, { title: "Declined one" });
  const dec = await omar.api("POST", `/api/v1/learning/proposals/${d2.body.proposal?.id}/decline`, { reason: "Not now" });
  check("learning: a declined proposal changes nothing", dec.status === 200 && (await skill()).body === sk0.body, `${dec.status} ${dec.body.msg}`);
  await asha.api("PUT", "/api/v1/learning/switch", { on: false, reason: "Back to off" });
  await omar.ctx.close();
}

let journeyWo = null;
/** One work order through every station and gate to Done, over the public API, each human gate approved by someone allowed and not the author. */
async function journey() {
  if (journeyWo) return journeyWo;
  log("== journey: a Chore work order from submission to Done");
  const submit = await asha.api("POST", "/api/v1/projects/payments/work-orders", { repo: "payments-api", title: "Bump the greeting helper dependency in payments-api", description: "Upgrade the greeting helper and add it under src/. Acceptance: helper exported and the build passes.", requestedCls: "chore" }, idem());
  const wo = submit.body.id; journeyWo = wo;
  const answers = ["Only payments-api", "Helper exported from src/ and the build passes.", "Revert the commit.", "Next patch release.", "None.", "Nothing else."];
  const done = async () => (await asha.api("GET", `/api/v1/work-orders/${wo}`)).body?.conv?.done === true;
  for (const a of answers) { if (await done()) break; await asha.api("POST", `/api/v1/work-orders/${wo}/messages`, { text: a }, idem()); await sleep(900); }
  const cb = await asha.api("POST", `/api/v1/work-orders/${wo}/confirm-brief`, {});
  check("journey: the brief is confirmed (G0G1, a person decides)", cb.status === 200, `${cb.status} ${cb.body.msg}`);
  const who = {}; const pool = ["daniel", "meera", "priya", "sam", "omar", "kenji", "grace", "hana"];
  const sessions = {};
  let approvals = 0; const gates = [];
  for (let guard = 0; guard < 40; guard++) {
    const st = await until("work order to settle", () => { const w = q(`select position,state from work_orders where id='${wo}'`)[0]; return ["waiting", "done", "failed", "blocked", "parked", "killed"].includes(w?.[1]) ? w : null; }, 420000, 2000).catch(() => ["?", "timeout"]);
    if (st[1] === "done" || st[1] === "timeout" || st[1] === "failed") break;
    const gate = q(`select id, gate_id from gate_instances where wo_id='${wo}' and status='open'`)[0];
    if (!gate) { await sleep(3000); continue; }
    let ok = false;
    for (const u of pool) {
      sessions[u] ??= await session(u);
      const r = await sessions[u].api("POST", `/api/v1/gate-instances/${gate[0]}/approve`, {});
      if (r.status === 200) { approvals++; gates.push(gate[1]); who[gate[1]] = u; ok = true; break; }
    }
    if (!ok) { log("no candidate could approve", gate[0]); break; }
    await sleep(2500);
  }
  for (const s of Object.values(sessions)) await s.ctx.close();
  const fin = q(`select position,state from work_orders where id='${wo}'`)[0];
  check("journey: the work order reaches Done through every station, each human gate approved by a person", fin?.[1] === "done", `${fin?.join("/")} gates=${gates.join(",")} approvers=${JSON.stringify(who)}`);
  return wo;
}

async function trust() {
  log("== trust: L0 and L1 enforced, levels above L1 off");
  let r = await asha.api("GET", "/api/v1/trust/cells?project=payments");
  check("trust: levels above L1 are switched off in a new install", r.body.levelsAboveL1 === false, `levelsAboveL1=${r.body.levelsAboveL1}`);
  const l2 = r.body.cells.find((c) => c.level >= 2);
  check("trust: a seeded L2 cell is held to L1 while the switch is off (effective level 1)", l2?.effective === 1, `${l2?.id} level=${l2?.level} effective=${l2?.effective}`);
  const l1 = r.body.cells.find((c) => c.level === 1 && c.project === "payments");
  r = await asha.api("POST", "/api/v1/trust/grants", { target: l1.id, level: 2, reason: "raise while the switch is off" }, { "if-match": String(l1.rev) });
  check("trust: granting L2 is refused (403 TRUST-SWITCH)", r.status === 403 && r.body.rule?.id === "TRUST-SWITCH", `${r.status} ${r.body.rule?.id}`);
  const cell = (await asha.api("GET", "/api/v1/trust/cells?project=payments")).body.cells.find((c) => c.id === l1.id);
  r = await asha.api("POST", "/api/v1/trust/grants", { target: cell.id, level: 0, reason: "shadow this cell for the acceptance run" }, { "if-match": String(cell.rev) });
  check("trust: a cell can be set to L0 (shadow) by a person with a reason, audited", r.status === 200 && q(`select count(*) from events where type like 'trust.%' and actor='p-asha'`)[0][0] > "0", `${r.status} ${r.body.msg}`);
  const wo = await journey();
  const gi = q(`select id, gate_id, status from gate_instances where wo_id='${wo}' order by opened_at`);
  const auto = q(`select count(*) from gate_votes v join gate_instances g on g.id = v.gate_instance_id where g.wo_id='${wo}' and (v.voter like 'system%' or v.voter is null)`)[0][0];
  check("trust: no gate on the journey was passed automatically (L0/L1: a person decided every one)", gi.length > 0 && auto === "0", `${gi.length} gates, auto votes=${auto}`);
  const bad = q(`select count(*) from events where type in ('gate.auto','trust.autopass') or (type like 'gate.%' and after::text like '%autoPass%')`)[0][0];
  check("trust: the ledger has no automatic gate decision", bad === "0", `events=${bad}`);
  await asha.api("POST", "/api/v1/trust/grants", { target: cell.id, level: 1, reason: "restore after the acceptance run" }, { "if-match": String((await asha.api("GET", "/api/v1/trust/cells?project=payments")).body.cells.find((c) => c.id === cell.id).rev) });
}

async function workload() {
  log("== workload: non-empty after a journey");
  await journey();
  const r = await asha.api("GET", "/api/v1/workload?scope=all&days=7");
  const t = r.body;
  check("workload: figures are non-empty after a journey (rows, totals)", r.status === 200 && (t.rows?.length ?? 0) > 0 && JSON.stringify(t.totals ?? {}) !== "{}", `${r.status} rows=${t.rows?.length} totals=${JSON.stringify(t.totals).slice(0, 160)} byProject=${JSON.stringify(t.byProject ?? []).slice(0, 80)}`);
  const p = await asha.api("GET", "/api/v1/workload?scope=payments&days=7");
  check("workload: a project scope reads too", p.status === 200 && (p.body.rows?.length ?? 0) > 0, `${p.status} rows=${p.body.rows?.length}`);
  const tom = await session("tomas"); const hid = await tom.api("GET", "/api/v1/workload?scope=risk&days=7");
  check("workload: a project the viewer cannot see is a 404", hid.status === 404, `${hid.status}`);
  await tom.ctx.close();
}

async function console_() {
  log("== console: says no model is configured");
  const st = await asha.api("GET", "/api/v1/console/status");
  check("console: status reports not configured, with a reason, and actions off", st.status === 200 && st.body.configured === false && !!st.body.reason && st.body.actionsEnabled === false, JSON.stringify(st.body).slice(0, 260));
  const r = await asha.api("POST", "/api/v1/console/messages", { text: "How many work orders are waiting on me?" }, idem());
  check("console: a question gets 'no model configured', not a made-up answer", /unavailable|not configured|No model/i.test(JSON.stringify(r.body)) , `${r.status} ${JSON.stringify(r.body).slice(0, 260)}`);
  const ex = await asha.api("POST", "/api/v1/console/explain", { person: "p-tomas", action: "gate.approve", project: "payments" });
  check("console: Explain still returns the policy trace without a model", ex.status === 200 && ex.body.mode === "trace", `${ex.status} mode=${ex.body.mode}`);
}

const sections = { budget, model, learning, trust, workload, console: console_ };
for (const [n, f] of Object.entries(sections)) if (want(n)) { try { await f(); } catch (e) { check(`${n}: section completed`, false, e.stack?.split("\n").slice(0, 3).join(" ")); } }
summary();
await close();
