/**
 * Eval commands (spec 8.7, 13.2). Running a suite and adding a case need `eval.run`. A run is real work through the production runtime, so a killed factory refuses it.
 * The loop (learning) can never edit a case or a grader on its own (spec 13.4): these are people's commands, and no agent route reaches them (I6).
 */
import type { Tx } from "@gantry/db";
import type { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { job } from "../../core/jobs-contract.js";
import { policyProjects } from "../../core/read/state.js";
import { readCatalog } from "../../core/read/index.js";
import { agentRows, labelOf, versionRows } from "../agents/store.js";
import { refuseIfFactoryKilled } from "../integrations/stop.js";
import type { CheckSpec } from "./checks.js";
import { cancelEvalRun, evalCap, newCaseSalt, newRunId, progressJob, type CaseSnapshot, type EvalItem, type RunData } from "./engine.js";
import type { CaseBody, RunBody } from "./schemas.js";
import { caseOut } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;
const json = (v: unknown): string => JSON.stringify(v);
const subject = (id: string) => ({ type: "suite", id });
const SHA = /^[0-9a-f]{40}$/;

/** The commit recorded for a repository, when a case names a repo and no commit (the snapshot is pinned now, so later changes to the repo do not move it). */
async function recordedCommit(tx: Tx, orgId: string, repoId: string): Promise<string | null> {
  const r = (await tx.query<{ cfg: string | null; repo: string | null }>(`select (select data->>'baseSha' from repo_config where org_id = $1 and repo_id = $2) as cfg, (select data->>'baseSha' from repos where org_id = $1 and id = $2) as repo`, [orgId, repoId])).rows[0];
  return [r?.cfg, r?.repo].find((x): x is string => !!x && SHA.test(x)) ?? null;
}

export async function addEvalCase(tx: Tx, a: Actor, suiteId: string, b: z.infer<typeof CaseBody>): Promise<Cmd> {
  const s = (await tx.query<{ id: string; name: string }>(`select id, name from suites where org_id = $1 and id = $2 for update`, [a.orgId, suiteId])).rows[0];
  if (!s) throw notFound("No such suite.");
  if (!b.name.trim()) throw invalid("Name the case.");
  const repo = b.repo ?? null;
  let commit = b.commit ?? null;
  if (repo) {
    const r = (await tx.query<{ project_id: string }>(`select project_id from repos where org_id = $1 and id = $2`, [a.orgId, repo])).rows[0];
    if (!r) throw invalid("No such repository.");
    if (b.project && b.project !== r.project_id) throw invalid("That repository belongs to another project.");
    commit = commit ?? (await recordedCommit(tx, a.orgId, repo));
    if (!commit) throw invalid("No commit is recorded for that repository. Give the commit the task is pinned to.");
  } else if (commit) {
    throw invalid("A commit needs a repository.");
  }
  if (b.project && !(await policyProjects(tx, a.orgId)).some((p) => p.id === b.project)) throw invalid("No such project.");
  if (b.cls && !(await readCatalog(tx, a.orgId)).classes.some((c) => c.id === b.cls)) throw invalid("No such work class.");
  if (b.skill && !(await tx.query(`select 1 from skills where org_id = $1 and id = $2`, [a.orgId, b.skill])).rowCount) throw invalid("No such skill.");
  const rules: CheckSpec[] = [
    ...b.rules,
    ...(b.mustMention ?? []).map((value): CheckSpec => ({ kind: "output_contains", value })),
    ...(b.mustNotMention ?? []).map((value): CheckSpec => ({ kind: "output_not_contains", value })),
    ...((b.mustNotTouch ?? []).length ? [{ kind: "path_not_touched" as const, paths: b.mustNotTouch! }] : []),
    // The person's own words are kept as an advisory check: they say what a passing answer looks like, and never decide.
    ...(b.checks ? [{ kind: "model_graded" as const, rubric: b.checks }] : []),
  ];
  const prefix = suiteId.replace("SUITE-", "").slice(0, 3).toUpperCase();
  const count = Number((await tx.query<{ n: string }>(`select count(*)::text as n from eval_cases where org_id = $1 and suite_id = $2`, [a.orgId, suiteId])).rows[0]!.n);
  let id = `${prefix}-${String(count + 1).padStart(2, "0")}`;
  while ((await tx.query(`select 1 from eval_cases where org_id = $1 and id = $2`, [a.orgId, id])).rowCount) id += newCaseSalt().slice(0, 1);
  const body = { by: a.id, added: a.now.getTime(), task: b.task || b.name.trim(), checks: b.checks ?? "", repo, commit, project: b.project ?? null, ...(b.cls ? { cls: b.cls } : {}), ...(b.skill ? { skill: b.skill } : {}), rules };
  await tx.query(`insert into eval_cases (org_id, id, suite_id, name, body, golden) values ($1,$2,$3,$4,$5::jsonb,$6)`, [a.orgId, id, suiteId, b.name.trim(), json(body), !!repo && !!commit]);
  const row = caseOut({ id, name: b.name.trim(), body, golden: !!repo && !!commit, created_at: a.now });
  return {
    msg: `${id} added to ${suiteId}.`, changes: ["suites", "evalRuns", "audit"], project: null, extra: { case: row },
    events: [{ type: "eval.case", category: "agents", subject: subject(suiteId), projectId: null, after: { case: id, name: row.name, repo, commit, rules: rules.length, golden: row.golden } }],
  };
}

/** The first non-archived project an agent is staffed on, for a case that names neither a repository nor a project. */
async function projectFor(tx: Tx, orgId: string, agentProjects: unknown): Promise<string | null> {
  const all = (await policyProjects(tx, orgId)).filter((p) => p.status !== "archived");
  const list = Array.isArray(agentProjects) ? all.filter((p) => (agentProjects as unknown[]).includes(p.id)) : all;
  return list[0]?.id ?? null;
}

export async function runSuite(tx: Tx, a: Actor, suiteId: string, b: z.infer<typeof RunBody>): Promise<Cmd> {
  await refuseIfFactoryKilled(tx, a.orgId, "eval runs");
  const s = (await tx.query<{ id: string; name: string; station: string | null; agent_id: string | null; data: Record<string, unknown> }>(`select id, name, station, agent_id, data from suites where org_id = $1 and id = $2 for update`, [a.orgId, suiteId])).rows[0];
  if (!s) throw notFound("No such suite.");
  const ag = (await agentRows(tx, a.orgId, b.agent))[0];
  if (!ag) throw invalid("Pick an agent and a suite.");
  if (s.agent_id && s.agent_id !== ag.id) throw invalid(`${s.id} is the suite for ${s.agent_id}, not ${ag.id}.`);
  const vers = await versionRows(tx, a.orgId, ag.id);
  const ver = vers.find((v) => labelOf(v) === String(b.version) || v.version === Number(b.version));
  if (!ver) throw notFound("No such version.");
  const station = s.station ?? ag.station;
  if (!station || !(await readCatalog(tx, a.orgId)).stations.some((x) => x.id === station)) throw invalid("This suite has no station to run at.");
  const cases = (await tx.query<{ id: string; name: string; body: Record<string, unknown> }>(`select id, name, body from eval_cases where org_id = $1 and suite_id = $2 order by created_at, id`, [a.orgId, s.id])).rows;
  if (!cases.length) throw invalid("The suite has no cases yet. Add one first.");
  if ((await tx.query(`select 1 from eval_runs where org_id = $1 and suite_id = $2 and status in ('queued','running')`, [a.orgId, s.id])).rowCount) throw conflict(`A run of ${s.id} is already in progress.`);

  const pinned = ver.model_id ?? "";
  let model = b.model ?? pinned;
  let vendor: string | null = null;
  if (model) {
    const m = (await tx.query<{ vendor_id: string; enabled: boolean; connected: boolean }>(`select m.vendor_id, m.enabled, v.connected from models m join vendors v on v.org_id = m.org_id and v.id = m.vendor_id where m.org_id = $1 and m.id = $2`, [a.orgId, model])).rows[0];
    if (!m) throw invalid(`No such model ${model}.`);
    if (!m.enabled || !m.connected) throw conflict(`${model} is not enabled on a connected vendor.`);
    vendor = m.vendor_id;
  }
  model = model || "";
  const snapshots: Record<string, CaseSnapshot> = {};
  const fallbackProject = await projectFor(tx, a.orgId, ag.data.projects);
  for (const c of cases) {
    const body = c.body;
    const repo = typeof body.repo === "string" ? body.repo : null;
    const repoProject = repo ? (await tx.query<{ project_id: string }>(`select project_id from repos where org_id = $1 and id = $2`, [a.orgId, repo])).rows[0]?.project_id ?? null : null;
    const project = (typeof body.project === "string" ? body.project : null) ?? repoProject ?? fallbackProject;
    if (!project) throw invalid(`Case ${c.id} has no project to run in.`);
    snapshots[c.id] = {
      name: c.name, task: typeof body.task === "string" && body.task ? body.task : c.name, repo, commit: typeof body.commit === "string" ? body.commit : null, project, cls: typeof body.cls === "string" ? body.cls : "feature",
      checks: Array.isArray(body.rules) ? (body.rules as CheckSpec[]) : [],
    };
  }
  const items: EvalItem[] = cases.flatMap((c) => Array.from({ length: b.repeats }, (_, i): EvalItem => ({ case: c.id, n: i + 1, state: "pending" })));
  const data: RunData = { agent: ag.id, version: labelOf(ver), versionNumber: ver.version, model, vendor, override: !!b.model && b.model !== pinned, repeats: b.repeats, station, cap: await evalCap(tx, a.orgId), items, cases: snapshots };
  const id = await newRunId(tx, a.orgId);
  await tx.query(`insert into eval_runs (org_id, id, suite_id, status, started_by, data) values ($1,$2,$3,'queued',$4,$5::jsonb)`, [a.orgId, id, s.id, a.personId ?? a.id, json(data)]);
  const j = progressJob(id);
  return {
    msg: `${id} started: ${cases.length} case${cases.length === 1 ? "" : "s"}${b.repeats > 1 ? ` run ${b.repeats} times each` : ""} on ${ag.name} ${data.version}${model ? ` (${model})` : " (no model: the stub adapter)"}.`,
    changes: ["evalRuns", "suites", "audit"], project: null, extra: { run: id, total: items.length },
    jobs: [{ kind: j.kind, queue: j.queue, payload: j.payload, ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}), ...(j.priority !== undefined ? { priority: j.priority } : {}) }],
    events: [{ type: "eval.run", category: "agents", subject: subject(s.id), projectId: null, after: { run: id, suite: s.id, agent: ag.id, version: data.version, model, cases: cases.length, repeats: b.repeats, override: data.override } }],
  };
}

export async function cancelRun(tx: Tx, a: Actor, suiteId: string, runId: string): Promise<Cmd> {
  const r = (await tx.query<{ status: string }>(`select status from eval_runs where org_id = $1 and id = $2 and suite_id = $3 for update`, [a.orgId, runId, suiteId])).rows[0];
  if (!r) throw notFound("No such run.");
  if (r.status !== "queued" && r.status !== "running") throw conflict(`${runId} is already ${r.status}.`);
  await cancelEvalRun(tx, a.orgId, runId, a.now);
  return { msg: `${runId} cancelled.`, changes: ["evalRuns", "suites", "audit"], project: null, events: [{ type: "eval.cancel", category: "agents", subject: subject(suiteId), projectId: null, after: { run: runId } }] };
}

export { job };
