/** Trigger commands (spec 8.8, 11.7, 12.5): save, dry run ("Simulate incoming"), fire, and release or decline a held proposal. Each runs inside `command()`. */
import { classesOf } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { readCatalog, readOrg } from "../../core/read/index.js";
import { loadFlowState } from "../../core/read/state.js";
import { readInstanceRow, metaOf, readType } from "../integrations/store.js";
import { keyCreator } from "../apikeys/store.js";
import { submitWO } from "../workorders/intake.js";
import { channelFor, evaluateTrigger, type RunCtx, type TriggerInput } from "./run.js";
import { nextRun, parseSchedule } from "./schedule.js";
import type { CreateInput, PatchInput } from "./schemas.js";
import { DEFAULT_LIMITS, readProposalRow, readTriggerRow, settingsOf, type TriggerRow, type Who } from "./store.js";

type Cmd = CommandResult<Record<string, unknown>>;

const idOf = async (tx: Tx, orgId: string): Promise<string> => {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`triggers:${orgId}`]);
  const n = (await tx.query<{ n: number }>(`select coalesce(max(substring(id from 4)::int), 0) + 1 as n from triggers where org_id = $1 and id ~ '^TR-[0-9]+$'`, [orgId])).rows[0]!.n;
  return `TR-${n}`;
};

/** The source of a trigger must be a connection that can be one (spec 12.1) and is open to the project, or the schedule. */
async function checkSource(tx: Tx, orgId: string, project: string, type: string, source: string): Promise<string> {
  if (type === "schedule") {
    if (source && source !== "schedule") throw invalid("A schedule has no external source.");
    return "schedule";
  }
  if (!source) throw invalid("Pick a source. Connect one in Integrations first.");
  const inst = await readInstanceRow(tx, orgId, source);
  if (!inst) throw invalid(`There is no connection ${source}.`);
  const t = await readType(tx, orgId, inst.type_id);
  if (!t?.source) throw invalid(`${inst.name} cannot be a trigger source.`);
  const projects = metaOf(inst.config).projects;
  if (projects !== "all" && !projects.includes(project)) throw invalid(`${inst.name} is not open to this project.`);
  if (type === "ci" && !["source", "ci", "custom", "webhook"].includes(t.category)) throw invalid(`${inst.name} does not report builds.`);
  return inst.id;
}

async function checkClasses(tx: Tx, orgId: string, project: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const st = await loadFlowState(tx, orgId);
  const p = st.projects.find((x) => x.id === project);
  if (!p) throw notFound("No such project.");
  const cat = await readCatalog(tx, orgId, await readOrg(tx, orgId));
  const have = new Set(classesOf(cat, p).map((c) => c.id));
  const bad = ids.filter((c) => !have.has(c));
  if (bad.length) throw invalid(`${project} has no class ${bad.join(", ")}.`);
}

async function checkRepo(tx: Tx, orgId: string, project: string, repo: string): Promise<void> {
  const r = (await tx.query(`select 1 from repos where org_id = $1 and id = $2 and project_id = $3`, [orgId, repo, project])).rowCount;
  if (!r) throw invalid(`${repo} is not a repository of ${project}.`);
}

const DEFAULTS: Record<string, Partial<Record<keyof CreateInput, unknown>>> = {
  issue: { label: "factory", labelMap: { bug: "bug", enhancement: "feature" }, reply: "Thanks. Gantry opened {wo}.", who: "org" },
  comment: { command: "/factory fix", reply: "On it: {wo}.", who: "org" },
  schedule: { schedule: "Mon 06:00 IST", who: "system" },
  ci: { reply: "Main is red. Proposed hotfix {wo} needs a person to confirm.", who: "proposal" },
};

/** A new trigger always starts switched off (spec 15.3): a person reviews it, then turns it on with a separate, audited change. */
export async function createTrigger(tx: Tx, a: Actor, b: CreateInput): Promise<Cmd> {
  if (b.enabled) throw invalid("A new trigger starts switched off. Review it, then turn it on.");
  const proj = (await tx.query<{ name: string; status: string }>(`select name, status from projects where org_id = $1 and id = $2`, [a.orgId, b.project])).rows[0];
  if (!proj) throw notFound("No such project.");
  if (proj.status === "archived") throw conflict(`${proj.name} is archived and read-only.`);
  const source = await checkSource(tx, a.orgId, b.project, b.type, b.source ?? "");
  const d = DEFAULTS[b.type] ?? {};
  const pick = <K extends keyof CreateInput>(k: K): CreateInput[K] | undefined => (b[k] !== undefined ? b[k] : (d[k] as CreateInput[K] | undefined));
  const who = (pick("who") ?? "org") as Who;
  if (b.type === "ci" && who === "org") throw invalid("A failing build has no acting user: hold it for a person, or let the system create it.");
  if (b.type === "schedule" && who === "org") throw invalid("A schedule has no acting user: let the system create it, or hold it for a person.");
  const config: Record<string, unknown> = { source, who, dedupe: pick("dedupe") ?? true, reply: pick("reply") ?? "", repos: "ready", limits: { ...DEFAULT_LIMITS, ...(b.limits ?? {}) } };
  if (b.type === "issue") {
    config.label = pick("label");
    config.labelMap = pick("labelMap") ?? {};
  }
  if (b.type === "comment") config.command = pick("command");
  let nextAt: Date | null = null;
  if (b.type === "schedule") {
    const text = String(pick("schedule") ?? "");
    const p = parseSchedule(text);
    if (!p.ok) throw invalid(p.msg);
    config.schedule = text;
    nextAt = null;
    if (b.title) config.title = b.title;
  }
  for (const k of ["cls", "repo", "priority"] as const) if (b[k]) config[k] = b[k];
  await checkClasses(tx, a.orgId, b.project, [...(typeof config.cls === "string" ? [config.cls] : []), ...Object.values((config.labelMap as Record<string, string> | undefined) ?? {})]);
  if (typeof config.repo === "string") await checkRepo(tx, a.orgId, b.project, config.repo);
  const id = await idOf(tx, a.orgId);
  await tx.query(`insert into triggers (org_id, id, project_id, kind, name, enabled, config, next_run_at, created_by, created_at) values ($1,$2,$3,$4,$5,false,$6::jsonb,$7,$8,$9)`, [a.orgId, id, b.project, b.type, b.name.trim(), JSON.stringify(config), nextAt, a.personId, a.now]);
  return {
    msg: `Trigger ${b.name.trim()} created. It starts disabled; review it, then turn it on.`,
    events: [{ type: "trigger.create", category: "integrations", subject: { type: "trigger", id }, projectId: b.project, after: { name: b.name.trim(), kind: b.type, source, enabled: false, who } }],
    extra: { trigger: { id } }, changes: ["triggers"], project: b.project,
  };
}

const CONFIG_KEYS = ["source", "label", "labelMap", "command", "schedule", "cls", "who", "reply", "dedupe", "title", "repo", "priority", "limits"] as const;

export async function patchTrigger(tx: Tx, a: Actor, id: string, b: PatchInput): Promise<Cmd> {
  const row = await readTriggerRow(tx, a.orgId, id, true);
  if (!row) throw notFound("No such trigger.");
  const project = row.project_id ?? "";
  const cur = settingsOf(row);
  const config = { ...row.config } as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (k: string, v: unknown, was: unknown): void => {
    if (JSON.stringify(v) === JSON.stringify(was)) return;
    before[k] = was;
    after[k] = v;
  };
  if (b.name !== undefined) set("name", b.name.trim(), row.name);
  const irrelevant = (k: string, kinds: string[]): void => {
    if ((b as Record<string, unknown>)[k] !== undefined && !kinds.includes(row.kind)) throw invalid(`A ${row.kind} trigger has no ${k}.`);
  };
  irrelevant("label", ["issue"]); irrelevant("labelMap", ["issue"]); irrelevant("command", ["comment"]); irrelevant("schedule", ["schedule"]); irrelevant("title", ["schedule"]);
  if (b.source !== undefined) {
    const src = await checkSource(tx, a.orgId, project, row.kind, b.source);
    set("source", src, cur.source);
    config.source = src;
  }
  if (b.label !== undefined) { set("label", b.label, cur.label); config.label = b.label; }
  if (b.labelMap !== undefined) { set("labelMap", b.labelMap, cur.labelMap); config.labelMap = b.labelMap; }
  if (b.command !== undefined) { set("command", b.command, cur.command); config.command = b.command; }
  if (b.schedule !== undefined) {
    const p = parseSchedule(b.schedule);
    if (!p.ok) throw invalid(p.msg);
    set("schedule", b.schedule, cur.schedule);
    config.schedule = b.schedule;
  }
  if (b.title !== undefined) { set("title", b.title, cur.title); config.title = b.title; }
  if (b.who !== undefined) {
    if (row.kind === "ci" && b.who === "org") throw invalid("A failing build has no acting user: hold it for a person, or let the system create it.");
    if (row.kind === "schedule" && b.who === "org") throw invalid("A schedule has no acting user: let the system create it, or hold it for a person.");
    set("who", b.who, cur.who); config.who = b.who;
  }
  if (b.reply !== undefined) { set("reply", b.reply, cur.reply); config.reply = b.reply; }
  if (b.dedupe !== undefined) { set("dedupe", b.dedupe, cur.dedupe); config.dedupe = b.dedupe; }
  for (const k of ["cls", "repo", "priority"] as const) {
    if (b[k] === undefined) continue;
    set(k, b[k], cur[k] || null);
    if (b[k]) config[k] = b[k];
    else delete config[k];
  }
  if (b.limits !== undefined) { const lim = { ...cur.limits, ...b.limits }; set("limits", lim, cur.limits); config.limits = lim; }
  await checkClasses(tx, a.orgId, project, [...(typeof config.cls === "string" ? [config.cls] : []), ...Object.values((config.labelMap as Record<string, string> | undefined) ?? {})]);
  if (typeof config.repo === "string") await checkRepo(tx, a.orgId, project, config.repo);
  const enabling = b.enabled !== undefined && b.enabled !== row.enabled;
  if (enabling) set("enabled", b.enabled, row.enabled);
  if (!Object.keys(after).length) return { msg: `${row.name} is unchanged.`, events: [], changes: ["triggers"], project, extra: { version: row.version } };
  const enabled = b.enabled ?? row.enabled;
  const name = after.name !== undefined ? String(after.name) : row.name;
  // A schedule that is on has a next run; changing when it runs moves it, switching it off clears it.
  let nextAt: Date | null = row.next_run_at;
  if (row.kind === "schedule") {
    const p = parseSchedule(String(config.schedule ?? ""));
    nextAt = enabled && p.ok ? nextRun(p.value, a.now) : null;
  }
  await tx.query(`update triggers set name = $3, enabled = $4, config = $5::jsonb, next_run_at = $6, version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, name, enabled, JSON.stringify(config), nextAt]);
  const onlyEnable = Object.keys(after).length === 1 && enabling;
  const master = enabling && b.enabled ? ((await tx.query<{ on: boolean }>(`select coalesce((settings -> 'api' ->> 'triggersEnabled')::boolean, false) as on from orgs where id = $1`, [a.orgId])).rows[0]?.on ?? false) : true;
  return {
    msg: onlyEnable ? `${name} ${b.enabled ? `enabled.${master ? "" : " Triggers are still switched off for the organisation (Limits tab)."}` : "disabled."}` : `Saved ${name}.`,
    events: [{ type: onlyEnable ? (b.enabled ? "trigger.enable" : "trigger.disable") : "trigger.edit", category: "integrations", subject: { type: "trigger", id }, projectId: project, before, after }],
    changes: ["triggers"], project, extra: { version: row.version + 1 },
  };
}

/** Evaluates a trigger against a sample event. Nothing is created unless the person asks (`create`), and then it goes through the same path as a real event. */
export async function simulateTrigger(tx: Tx, a: Actor, id: string, b: { repo?: string | undefined; title?: string | undefined; body?: string | undefined; labels?: string[] | undefined; author?: string | undefined; comment?: string | undefined; check?: string | undefined; create?: boolean | undefined }): Promise<Cmd> {
  const row = await readTriggerRow(tx, a.orgId, id, true);
  if (!row) throw notFound("No such trigger.");
  const kind = row.kind as TriggerInput["kind"];
  const input: TriggerInput = {
    kind, repo: b.repo, title: b.title, body: b.body, labels: b.labels, author: b.author, comment: b.comment, check: b.check,
    ref: kind === "schedule" ? "schedule tick" : `${b.repo ?? "repo"}#sim`,
  };
  const ctx: RunCtx = { orgId: a.orgId, now: a.now, requestId: a.requestId, ip: a.ip, channel: channelFor(kind), onBehalfOf: a.personId };
  const create = b.create === true;
  const r = await evaluateTrigger(tx, ctx, row, input, { dryRun: !create, simulated: true });
  const msg = create ? (r.outcome === "created" ? `Created ${r.wo}.` : r.msg) : r.msg;
  return {
    msg,
    events: [{ type: "trigger.simulate", category: "integrations", subject: { type: "trigger", id }, projectId: row.project_id, after: { trigger: row.name, created: create && r.outcome === "created", outcome: r.outcome, msg: r.msg, would: r.would } }],
    extra: { created: create, run: { at: a.now.getTime(), outcome: r.outcome, wo: r.wo ?? "", proposal: r.proposal, source: input.ref, msg: r.msg, person: r.person }, would: r.would, reply: r.reply, notes: r.would.notes },
    changes: create ? ["triggers", "workOrders"] : [], project: row.project_id,
  };
}

/** `POST /triggers/{id}/fire`: a key fires a trigger from its own system, with the same dedupe, author and limit rules. The Idempotency-Key is the event's identity. */
export async function fireTrigger(tx: Tx, a: Actor, id: string, keyId: string, keyProject: string | null, b: { title?: string | undefined; body?: string | undefined; repo?: string | undefined; author?: string | undefined }): Promise<Cmd> {
  const row = await readTriggerRow(tx, a.orgId, id, true);
  if (!row || (keyProject && row.project_id !== keyProject)) throw notFound("No such trigger.");
  const creator = await keyCreator(tx, a.orgId, keyId);
  const input: TriggerInput = { kind: "fire", repo: b.repo, title: b.title, body: b.body, author: b.author, ref: `API key ${keyId}`, ...(creator ? { keyPerson: creator } : {}), ...(a.idempotencyKey ? { dedupeKey: `fire:${a.idempotencyKey}` } : {}) };
  const ctx: RunCtx = { orgId: a.orgId, now: a.now, requestId: a.requestId, ip: a.ip, channel: "api", onBehalfOf: creator };
  const r = await evaluateTrigger(tx, ctx, row, input);
  if (r.outcome === "skipped") throw conflict(r.msg);
  return {
    msg: r.outcome === "created" ? `Created ${r.wo}.` : r.msg,
    events: [{ type: "trigger.fire", category: "api", subject: { type: "trigger", id }, projectId: row.project_id, woId: r.wo, after: { trigger: row.name, outcome: r.outcome, ...(r.wo ? { wo: r.wo } : {}), ...(r.proposal ? { proposal: r.proposal } : {}) } }],
    extra: { outcome: r.outcome, wo: r.wo, proposal: r.proposal, msg: r.msg }, changes: ["triggers"], project: row.project_id,
  };
}

/** A person who may submit to the project releases a held proposal: the ordinary submission, in their name, with the proposal's text as data. */
export async function releaseProposal(tx: Tx, a: Actor, id: string, note: string): Promise<Cmd> {
  const p = await readProposalRow(tx, a.orgId, id, true);
  if (!p) throw notFound("No such proposal.");
  if (p.status !== "held") throw conflict(`Proposal ${id} was already ${p.status}.`);
  if (!p.repo_id) throw invalid("The proposal has no repository.");
  const trig = await readTriggerRow(tx, a.orgId, p.trigger_id);
  const source = trig?.kind === "schedule" ? "schedule" : trig?.kind === "fire" ? "api" : "github";
  await tx.query("savepoint release_proposal");
  let sub: Cmd;
  try {
    sub = await submitWO(tx, a, p.project_id, { repo: p.repo_id, title: p.title, description: `${p.description}\n\nReleased by a person from held proposal ${p.id}.${note ? ` Note: ${note}` : ""}`, requestedCls: p.requested_class, ...(p.priority ? { priority: p.priority } : {}), source });
  } catch (e) {
    await tx.query("rollback to savepoint release_proposal");
    throw e;
  }
  const wo = String(sub.extra?.id ?? "");
  await tx.query(`update trigger_proposals set status = 'released', wo_id = $3, decided_by = $4, decided_at = $5, decision_note = $6, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, wo, a.personId, a.now, note]);
  return {
    msg: `Released ${id}: ${wo} created.`,
    events: [...sub.events, { type: "trigger.proposal.release", category: "integrations", subject: { type: "proposal", id }, projectId: p.project_id, woId: wo, after: { trigger: p.trigger_id, wo, actor: p.actor, reason: p.reason } }],
    ...(sub.jobs ? { jobs: sub.jobs } : {}), extra: { ...sub.extra, wo, proposal: id }, changes: [...new Set([...(sub.changes ?? []), "triggers"])], project: p.project_id,
  };
}

export async function declineProposal(tx: Tx, a: Actor, id: string, reason: string): Promise<Cmd> {
  const p = await readProposalRow(tx, a.orgId, id, true);
  if (!p) throw notFound("No such proposal.");
  if (p.status !== "held") throw conflict(`Proposal ${id} was already ${p.status}.`);
  if (!reason.trim()) throw refuse("invalid", "Say why it is declined.");
  await tx.query(`update trigger_proposals set status = 'declined', decided_by = $3, decided_at = $4, decision_note = $5, updated_at = now() where org_id = $1 and id = $2`, [a.orgId, id, a.personId, a.now, reason.trim()]);
  return {
    msg: `Declined ${id}.`,
    events: [{ type: "trigger.proposal.decline", category: "integrations", subject: { type: "proposal", id }, projectId: p.project_id, after: { trigger: p.trigger_id, actor: p.actor, reason: reason.trim() } }],
    changes: ["triggers"], project: p.project_id,
  };
}

export type { TriggerRow };
