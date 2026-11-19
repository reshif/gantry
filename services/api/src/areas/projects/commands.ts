import { createHash, randomBytes } from "node:crypto";
import { can, gateLock, ruleWarning, isFactoryAdminPerson, type ApproverRule, type Project, type ProjectFlow, type Template, type WorkClass } from "@gantry/domain";
import { cancel, schedule, type Tx } from "@gantry/db";
import type { z } from "zod";
import type { Actor, CommandResult, EventSpec } from "../../core/command.js";
import { capOfReason, overBudget, overText } from "../workorders/budget-state.js";
import { liftBudgetHalt } from "../workorders/budget.js";
import { isMandatoryEvent } from "../notifications/events.js";
import { dispatchQueued, newFx } from "../workorders/engine.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { job } from "../../core/jobs-contract.js";
import { loadPolicyState } from "../../core/read/state.js";
import { readCatalog, readPeople, readRoles, readTemplates } from "../../core/read/index.js";
import { pruneOncall } from "./oncall.js";
import { parseConfigEdit, type ConfigEdit } from "./config.js";
import { addBay, addClass, type OverrideRecord, addGate, addStation, draftOf, moveStation, removeStation, replaceClasses, setEnabled, setGateMode, setRunLimits, setWip, updateClass, type FlowDraft } from "./flowedit.js";
import { approversPreset, flowFrom, routesPreset } from "./presets.js";
import { checkRule, checkRuleRefs, ruleContext } from "./rules.js";
import type { ArchiveBody, BayBody, ClassBody, ClassPatch, GateBody, MoveBody, NewProject, StationBody, TemplateCreate, TemplatePatch, ViewCreate, ViewPatch } from "./schemas.js";
import {
  factoryAdminActor, loadDraft, lockProject, openByClass, openWorkOrders, persistDraft, publishRule, readProject, saveCatalog,
} from "./store.js";
import { applyCustom, checkTemplatePatch, customCount, customOf, templateBodyFromProject, type TemplateCustom } from "./templates.js";

type Out<X extends object = Record<string, never>> = CommandResult<X>;

const json = (v: unknown): string => JSON.stringify(v);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Legacy project id: the name lower-cased with runs of other characters turned into single dashes. */
export const projectIdFor = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function bumpProject(tx: Tx, orgId: string, id: string): Promise<number> {
  return Number((await tx.query(`update projects set version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [orgId, id])).rows[0].version);
}

const evt = (type: string, projectId: string, subject: { type: string; id: string }, before?: unknown, after?: unknown, category: EventSpec["category"] = "config"): EventSpec => ({
  type, category, subject, projectId, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}),
});

/* ------------------------------------------------------------------ create -- */

type NewProjectBody = z.infer<typeof NewProject>;

export async function createProject(tx: Tx, a: Actor, body: NewProjectBody): Promise<Out<{ project: Project; custom: { done: string[]; failed: string[] } }>> {
  const name = body.name.trim();
  if (name.length < 3) throw invalid("Name the project (3+ characters).");
  const id = projectIdFor(name);
  if (!id) throw invalid("Name the project (3+ characters).");
  const org = a.orgId;
  if ((await tx.query(`select 1 from projects where org_id = $1 and id = $2`, [org, id])).rowCount) throw conflict(`A project called ${name} already exists.`);
  let key = (body.key || id.replace(/-/g, "").slice(0, 3)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.length < 2 || key.length > 5) throw invalid("The key is 2 to 5 letters or digits.");
  const usedBy = async (k: string) => (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and key = $2`, [org, k])).rows[0];
  const taken = await usedBy(key);
  if (taken && body.key) throw conflict(`The key ${key} is already used by ${taken.name}.`);
  // a derived key that is taken gets a number: BEH, BEH2, BEH3 ...
  for (let n = 2; (await usedBy(key)) && n < 100; n++) key = `${key.replace(/\d+$/, "").slice(0, 5 - String(n).length)}${n}`;

  const tpl = (await readTemplates(tx, org)).find((t) => t.id === body.templateId);
  if (!tpl) throw invalid("Pick a template.");
  const people = await readPeople(tx, org);
  const ownerId = body.owner ?? a.personId;
  const owner = people.find((p) => p.id === ownerId);
  if (!owner || owner.status !== "active") throw invalid("Pick an active person as the owner.");
  if (body.teams.length) {
    const known = new Set((await tx.query<{ id: string }>(`select id from teams where org_id = $1`, [org])).rows.map((r) => r.id));
    const bad = body.teams.filter((t) => !known.has(t));
    if (bad.length) throw invalid(`There is no team ${bad.join(", ")}.`);
  }
  const catalog = await readCatalog(tx, org);
  if (body.approvers) checkRuleRefs(body.approvers as Record<string, ApproverRule>, await ruleContext(tx, org, null, catalog.roles));

  if (tpl.approverPreset === "strict") {
    const bad = (tpl.gatesOff ?? []).filter((g) => gateLock({ id: g }, { regulated: true }).locked);
    if (bad.length) throw invalid(`A regulated project keeps every gate on, so ${tpl.name} cannot be used with ${bad.join(", ")} off.`);
  }
  const flow = flowFrom(catalog, tpl);
  const approvers: Record<string, ApproverRule> = (body.approvers as Record<string, ApproverRule> | null | undefined) ?? (tpl.approvers ? (JSON.parse(json(tpl.approvers)) as Record<string, ApproverRule>) : approversPreset(tpl.approverPreset, catalog));
  const draft = draftOf(id, flow, approvers, catalog);
  const custom = customCount(customOf(tpl as Template & { custom?: unknown })) ? await replayCustom(tx, org, draft, tpl as Template & { custom?: unknown }) : { done: [] as string[], failed: [] as string[] };
  if (draft.catalogChanged) await saveCatalog(tx, org, draft.catalog);

  const description = body.desc?.trim() || `Created from ${tpl.name}.`;
  await tx.query(
    `insert into projects (org_id, id, key, name, description, status, owner_id, template_id, regulated, config, current_flow_version)
     values ($1,$2,$3,$4,$5,'new',$6,$7,$8,$9::jsonb,1)`,
    [org, id, key, name, description, ownerId, tpl.id, tpl.approverPreset === "strict", json({ mcp: tpl.mcp ?? [], mtd: 0, extra: {} })],
  );
  for (const t of new Set(body.teams)) await tx.query(`insert into project_teams (org_id, project_id, team_id) values ($1,$2,$3)`, [org, id, t]);
  await tx.query(`insert into flow_versions (org_id, project_id, version, doc, note, published_at, published_by) values ($1,$2,1,$3::jsonb,$4, now(), $5)`, [org, id, json(draft.flow), `Created from ${tpl.name}`, a.id]);
  for (const [gateId, g] of Object.entries(draft.flow.gates)) {
    if (g.absent) continue;
    await tx.query(`insert into gate_modes (org_id, project_id, gate_id, mode, enabled) values ($1,$2,$3,$4,$5)`, [org, id, gateId, g.mode, g.enabled]);
  }
  for (const [gateId, rule] of Object.entries(draft.approvers)) await publishRule(tx, org, id, gateId, rule, a.id, `Created from ${tpl.name}`);
  const routes = body.notifications ?? routesPreset(tpl.notify);
  for (const [i, r] of routes.entries()) {
    await tx.query(
      `insert into notification_routes (org_id, id, project_id, event, destinations, template, conditions, fields, enabled) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9)`,
      [org, `${id}:${r.id || `NR-${i + 1}`}`, id, r.event, json(r.dest), r.template, json(r.cond), json(r.fields), r.enabled],
    );
  }
  await tx.query(`insert into budgets (org_id, project_id, monthly_limit_micros, monthly_zero_cap, alert_at) values ($1,$2,$3,$4,0.8)`, [org, id, Math.round((body.budget ?? 1000) * 1_000_000), false]);

  const events: EventSpec[] = [evt("project.create", id, { type: "project", id }, undefined, { name, key, template: tpl.id, owner: ownerId })];
  const grant = !isFactoryAdminPerson(owner);
  if (grant) {
    await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1,$2,$3,'project_admin','project',$4,$5)`, [org, `ra-${randomBytes(6).toString("hex")}`, ownerId, id, a.id]);
    await tx.query(`insert into project_members (org_id, project_id, person_id) values ($1,$2,$3) on conflict do nothing`, [org, id, ownerId]);
    await tx.query(`update people set version = version + 1, updated_at = now() where org_id = $1 and id = $2`, [org, ownerId]);
    events.push(evt("role.grant", id, { type: "person", id: owner.id }, "", "project_admin", "access"));
  }
  const project = (await readProject(tx, org, id))!;
  const added = custom.done.length ? ` Added ${custom.done.join(", ")}.` : "";
  const failed = custom.failed.length ? ` Not added: ${custom.failed.join("; ")}.` : "";
  return { msg: `${name} created.${added}${failed}`, events, extra: { project, custom }, changes: ["projects", "people", "templates"], project: id };
}

async function replayCustom(tx: Tx, org: string, draft: FlowDraft, tpl: Template & { custom?: unknown }): Promise<{ done: string[]; failed: string[] }> {
  const agents = new Set((await tx.query<{ id: string }>(`select id from agents where org_id = $1`, [org])).rows.map((r) => r.id));
  return applyCustom(draft, customOf(tpl), agents);
}

/* ------------------------------------------------------------------ config -- */

const jsonOf = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as unknown;

/** `PATCH /projects/{id}/config` with `{ path, value }`. Flow edits publish a new flow version; the rest update the project in place and bump its version. */
export async function setConfig(tx: Tx, a: Actor, projectId: string, edit: ConfigEdit, path: string, reason?: string): Promise<Out<{ version: number; flowVersion?: number }>> {
  const row = await lockProject(tx, a.orgId, projectId, a.ifMatch);
  const org = a.orgId;
  const subject = { type: "project", id: projectId };
  const done = async (type: string, before: unknown, after: unknown, msg: string, category: EventSpec["category"] = "config", flowVersion?: number): Promise<Out<{ version: number; flowVersion?: number }>> => {
    const version = flowVersion === undefined ? await bumpProject(tx, org, projectId) : Number((await tx.query(`select version from projects where org_id = $1 and id = $2`, [org, projectId])).rows[0].version);
    return {
      msg, events: [{ ...evt(type, projectId, subject, jsonOf(before), jsonOf(after), category), subject: { ...subject, path } }],
      extra: { version, ...(flowVersion !== undefined ? { flowVersion } : {}) }, changes: ["projects"], project: projectId,
    };
  };

  /** A lock overridden by a Factory Admin: one `flow.override` event with project, gate, before, after and the reason, in the project's audit. */
  const overridden = async (o: OverrideRecord, msg: string, flowVersion: number): Promise<Out<{ version: number; flowVersion?: number }>> => {
    const version = Number((await tx.query(`select version from projects where org_id = $1 and id = $2`, [org, projectId])).rows[0].version);
    return { msg, events: [flowOverrideEvent(projectId, o)], extra: { version, flowVersion }, changes: ["projects", "floor"], project: projectId };
  };

  switch (edit.kind) {
    case "desc":
    {
      const before = (await tx.query<{ description: string }>(`select description from projects where org_id = $1 and id = $2`, [org, projectId])).rows[0]?.description ?? "";
      await tx.query(`update projects set description = $3 where org_id = $1 and id = $2`, [org, projectId, edit.value]);
      return done("project.config", before, edit.value, `Saved ${path}.`);
    }
    case "overlay": {
      await tx.query(`update projects set overlay = $3 where org_id = $1 and id = $2`, [org, projectId, edit.value]);
      const v = Number((await tx.query(`select coalesce(max(version), 0) + 1 as v from instruction_versions where org_id = $1 and scope = 'project' and scope_id = $2`, [org, projectId])).rows[0].v);
      await tx.query(`insert into instruction_versions (org_id, scope, scope_id, version, body, hash, note, published_at, published_by) values ($1,'project',$2,$3,$4,$5,'', now(), $6)`, [org, projectId, v, edit.value, sha(edit.value), a.id]);
      return done("project.config", `v${v - 1}`, `v${v}`, `Saved ${path}.`);
    }
    case "owner": {
      const p = (await readPeople(tx, org)).find((x) => x.id === edit.value);
      if (!p || p.status !== "active") throw invalid("Pick an active person as the owner.");
      await tx.query(`update projects set owner_id = $3 where org_id = $1 and id = $2`, [org, projectId, edit.value]);
      return done("project.config", row.owner_id, edit.value, `Saved ${path}.`);
    }
    case "mcp": {
      const known = new Set((await tx.query<{ id: string }>(`select id from mcp_servers where org_id = $1`, [org])).rows.map((r) => r.id));
      const bad = edit.value.filter((s) => !known.has(s));
      if (bad.length) throw invalid(`There is no MCP server ${bad.join(", ")}.`);
      const before = (row.config as { mcp?: string[] }).mcp ?? [];
      await tx.query(`update projects set config = jsonb_set(config, '{mcp}', $3::jsonb) where org_id = $1 and id = $2`, [org, projectId, json([...new Set(edit.value)])]);
      return done("project.config", before, edit.value, `Saved ${path}.`);
    }
    case "oncall-page": {
      // Whether the default page to the people on call goes out for halts, blocked work orders, security holds and escalations. Kill and restore page whatever this says.
      const before = (row.config as { oncallPage?: boolean }).oncallPage !== false;
      await tx.query(`update projects set config = jsonb_set(config, '{oncallPage}', $3::jsonb) where org_id = $1 and id = $2`, [org, projectId, json(edit.value)]);
      return done("project.config", before, edit.value, `On-call page ${edit.value ? "on" : "off"} for halts, blocked work orders, security holds and escalations. Kill and restore always page.`);
    }
    case "notifications": {
      const old = (await readProject(tx, org, projectId))!.notifications;
      // The kill and restore routes are locked as they are on the single-route path (S-35): none may be dropped, switched off or narrowed by a bulk save.
      const next = new Map(edit.value.map((r, i) => [r.id || `NR-${i + 1}`, r]));
      for (const o of old.filter((r) => isMandatoryEvent(r.event))) {
        const n = next.get(o.id);
        if (!n || n.event !== o.event) throw conflict("Kill and restore routes cannot be removed. Change where they go instead.");
      }
      for (const r of edit.value) {
        if (isMandatoryEvent(r.event) && (!r.enabled || r.cond.classes.length || r.cond.priority.length || r.cond.hours !== "any")) throw invalid("Kill and restore notifications cannot be switched off or narrowed.");
      }
      await tx.query(`delete from notification_routes where org_id = $1 and project_id = $2`, [org, projectId]);
      const ids = new Set<string>();
      for (const [i, r] of edit.value.entries()) {
        const rid = r.id || `NR-${i + 1}`;
        if (ids.has(rid)) throw invalid(`Route id ${rid} appears twice.`);
        ids.add(rid);
        await tx.query(
          `insert into notification_routes (org_id, id, project_id, event, destinations, template, conditions, fields, enabled) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9)`,
          [org, `${projectId}:${rid}`, projectId, r.event, json(r.dest), r.template, json(r.cond), json(r.fields), r.enabled],
        );
      }
      return done("notify.edit", old, edit.value, `Saved ${path}.`, "integrations");
    }
    case "budget-monthly": {
      // 0 or null means no cap (owner decision, reversing the S-43 zero cap); monthly_zero_cap is never set and stays false.
      const prior = (await tx.query<{ m: string }>(`select monthly_limit_micros::text as m from budgets where org_id = $1 and project_id = $2`, [org, projectId])).rows[0];
      const beforeCap: number | null = prior && Number(prior.m) > 0 ? Number(prior.m) / 1_000_000 : null;
      const before = beforeCap ?? 0;
      const value: number | null = edit.value !== null && edit.value > 0 ? edit.value : null;
      await tx.query(
        `insert into budgets (org_id, project_id, monthly_limit_micros, monthly_zero_cap) values ($1,$2,$3,$4) on conflict (org_id, project_id) do update set monthly_limit_micros = excluded.monthly_limit_micros, monthly_zero_cap = excluded.monthly_zero_cap, version = budgets.version + 1, updated_at = now()`,
        [org, projectId, value === null ? 0 : Math.round(value * 1_000_000), false],
      );
      // Raising the monthly budget lifts the budget halts it was holding (audited as a resume, naming the cap), unless something else still holds the work order.
      const lifted: string[] = [];
      const kept: string[] = [];
      const events: EventSpec[] = [];
      const jobs: NonNullable<CommandResult["jobs"]> = [];
      if (value === null || value > before) {
        const halts = (await tx.query<{ wo_id: string; reason: string }>(
          `select s.wo_id, s.reason from stops s join work_orders w on w.org_id = s.org_id and w.id = s.wo_id where s.org_id = $1 and w.project_id = $2 and s.scope_type = 'wo' and s.mode = 'halt' and s.cause = 'budget' and s.lifted_at is null order by s.wo_id`, [org, projectId],
        )).rows;
        for (const h of halts) {
          if (capOfReason(h.reason) !== "project") continue;
          const still = await overBudget(tx, org, h.wo_id);
          if (still.length) { kept.push(`${h.wo_id} (${still.map(overText).join(" and ")})`); continue; }
          const l = await liftBudgetHalt(tx, a, h.wo_id, value === null ? "Project monthly cap taken off" : `Project monthly budget raised to $${value}`);
          events.push(...l.events);
          jobs.push(...l.jobs);
          lifted.push(h.wo_id);
        }
      }
      const r = await done("project.config", beforeCap, value, `${value === null ? "Took the monthly cap off." : `Saved ${path}.`}${lifted.length ? ` Lifted the budget halt on ${lifted.join(", ")}.` : ""}${kept.length ? ` Still halted: ${kept.join("; ")}.` : ""}`);
      return lifted.length ? { ...r, events: [...r.events, ...events], jobs, changes: [...(r.changes ?? []), "workOrders", "stops", "floor", "home"] } : r;
    }
    case "budget-alert": {
      const before = Number((await tx.query(`select alert_at from budgets where org_id = $1 and project_id = $2`, [org, projectId])).rows[0]?.alert_at ?? 0.8);
      await tx.query(
        `insert into budgets (org_id, project_id, alert_at) values ($1,$2,$3) on conflict (org_id, project_id) do update set alert_at = excluded.alert_at, version = budgets.version + 1, updated_at = now()`,
        [org, projectId, edit.value],
      );
      return done("project.config", before, edit.value, `Saved ${path}.`);
    }
    default:
      break;
  }

  // Flow edits: change a draft, then publish a new flow version.
  const { draft } = await loadDraft(tx, org, projectId);
  let before: unknown;
  let after: unknown;
  switch (edit.kind) {
    case "slots":
      before = draft.flow.slots;
      draft.flow.slots = edit.value;
      after = edit.value;
      break;
    case "station-enabled": {
      const adm = await factoryAdminActor(tx, a);
      // The lock is judged first (a station carrying G5 is refused whoever asks), then whether work is at it.
      const r = setEnabled(draft, "stations", edit.id, edit.value, { regulated: !!row.regulated, admin: !!adm, reason, by: a.id, byName: adm?.name ?? a.name, at: a.now.getTime() });
      if (!edit.value) {
        const busy = await openWorkOrders(tx, org, projectId, { position: edit.id });
        if (busy) throw conflict(`${busy} work order${busy > 1 ? "s are" : " is"} at ${draft.catalog.stations.find((s) => s.id === edit.id)?.name ?? edit.id}. Move ${busy > 1 ? "them" : "it"} first.`);
      }
      before = r.before;
      after = edit.value;
      if (r.override) {
        const flowVersion = await persistDraft(tx, org, draft, a.id, `${path} (override: ${r.override.reason})`);
        const name = draft.catalog.stations.find((s) => s.id === edit.id)?.name ?? edit.id;
        return overridden(r.override, `${name} turned off by Factory Admin override.`, flowVersion);
      }
      break;
    }
    case "gate-enabled": {
      const adm = await factoryAdminActor(tx, a);
      const r = setEnabled(draft, "gates", edit.id, edit.value, { regulated: !!row.regulated, admin: !!adm, reason, by: a.id, byName: adm?.name ?? a.name, at: a.now.getTime() });
      before = r.before;
      after = edit.value;
      const flowVersion = await persistDraft(tx, org, draft, a.id, r.override ? `${path} (override: ${r.override.reason})` : path);
      const gd = draft.catalog.gates.find((g) => g.id === edit.id)!;
      const inflight = edit.value ? 0 : await openWorkOrders(tx, org, projectId, {});
      if (r.override) return overridden(r.override, `${gd.name} (${gd.label}) turned off by Factory Admin override.${inflight ? ` ${inflight} open work order${inflight > 1 ? "s keep" : " keeps"} the flow ${inflight > 1 ? "they" : "it"} started with.` : ""}`, flowVersion);
      return done("project.config", before, after, `${gd.name} (${gd.label}) turned ${edit.value ? "on" : "off"}.${edit.value ? "" : ` New work orders skip it${inflight ? `; ${inflight} open work order${inflight > 1 ? "s keep" : " keeps"} the flow ${inflight > 1 ? "they" : "it"} started with` : ""}.`}`, "config", flowVersion);
    }
    case "station-wip":
      before = setWip(draft, edit.id, edit.value).before;
      after = edit.value;
      break;
    case "station-run-limits": {
      const r = setRunLimits(draft, edit.id, edit.value);
      before = r.before;
      after = r.after;
      break;
    }
    case "classes": {
      const r = replaceClasses(draft, edit.value, await openByClass(tx, org, projectId), { regulated: !!row.regulated });
      before = r.before.map((c) => c.id);
      after = r.after;
      break;
    }
    default:
      throw invalid(`${path} is not an editable project setting.`);
  }
  const flowVersion = await persistDraft(tx, org, draft, a.id, path);
  const saved = await done("project.config", before, after, `Saved ${path}.`, "config", flowVersion);
  if (edit.kind !== "slots" || !(Number(after) > Number(before))) return saved;
  // Raising the coding slots: queued work takes the free slots now, in priority then age order (S-32).
  const fx = await newFx(tx, org, a.id, a.now);
  const started = await dispatchQueued(fx, projectId);
  if (!started.length) return saved;
  return {
    ...saved, msg: `Saved ${path}. ${started.join(", ")} left the Queue for the new slot${started.length > 1 ? "s" : ""}.`,
    events: [...saved.events, ...fx.events], jobs: [...(saved.jobs ?? []), ...fx.jobs], changes: [...new Set([...(saved.changes ?? []), "workOrders", "floor", "home"])],
  };
}

const modeText = (m: string): string => (m === "auto" ? "automatic" : m === "mixed" ? "checks, then a person" : "a human approval");

/** The audited event for an override of a gate lock (owner decision 2026-11-19). */
const flowOverrideEvent = (projectId: string, o: OverrideRecord): EventSpec => ({
  type: "flow.override", category: "config", subject: { type: o.kind === "mode" ? "gaterule" : "gate", id: `${projectId}:${o.gate}` }, projectId,
  before: { project: projectId, gate: o.gate, ...(o.station ? { station: o.station } : {}), [o.kind === "mode" ? "mode" : "enabled"]: o.before },
  after: { project: projectId, gate: o.gate, ...(o.station ? { station: o.station } : {}), [o.kind === "mode" ? "mode" : "enabled"]: o.after, override: true, kind: o.kind, reason: o.reason },
});

export async function changeGateMode(tx: Tx, a: Actor, projectId: string, gateId: string, mode: string, reason?: string): Promise<Out<{ version: number; flowVersion: number }>> {
  await lockProject(tx, a.orgId, projectId, a.ifMatch);
  const { draft, project } = await loadDraft(tx, a.orgId, projectId);
  const adm = await factoryAdminActor(tx, a);
  const r = setGateMode(draft, gateId, mode, { regulated: !!project.regulated, admin: !!adm, reason, by: a.id, byName: adm?.name ?? a.name, at: a.now.getTime() });
  const flowVersion = await persistDraft(tx, a.orgId, draft, a.id, `${r.gate.name} (${r.gate.label}) mode${r.override ? ` (override: ${r.override.reason})` : ""}`);
  const version = Number((await tx.query(`select version from projects where org_id = $1 and id = $2`, [a.orgId, projectId])).rows[0].version);
  return {
    msg: `${r.gate.name} (${r.gate.label}) is now ${modeText(mode)} on ${project.name}.`,
    events: [evt("flow.gate", projectId, { type: "gaterule", id: `${projectId}:${gateId}` }, r.before, mode), ...(r.override ? [flowOverrideEvent(projectId, r.override)] : [])],
    extra: { version, flowVersion }, changes: ["projects"], project: projectId,
  };
}

/* -------------------------------------------------------------------- flow -- */

async function flowCommand<X extends object>(tx: Tx, a: Actor, projectId: string, note: string, fn: (d: FlowDraft, project: Project) => Promise<{ msg: string; events: EventSpec[]; extra: X }> | { msg: string; events: EventSpec[]; extra: X }): Promise<Out<X & { version: number; flowVersion: number }>> {
  await lockProject(tx, a.orgId, projectId, a.ifMatch);
  const { draft, project } = await loadDraft(tx, a.orgId, projectId);
  const r = await fn(draft, project);
  const flowVersion = await persistDraft(tx, a.orgId, draft, a.id, note);
  const version = Number((await tx.query(`select version from projects where org_id = $1 and id = $2`, [a.orgId, projectId])).rows[0].version);
  return { msg: r.msg, events: r.events, extra: { ...r.extra, version, flowVersion }, changes: ["projects", "floor"], project: projectId };
}

export function addStationCmd(tx: Tx, a: Actor, projectId: string, body: z.infer<typeof StationBody>) {
  return flowCommand(tx, a, projectId, "Add station", async (d, project) => {
    const def = body.def;
    const agentKnown = !!(await tx.query(`select 1 from agents where org_id = $1 and id = $2`, [a.orgId, def.agent])).rowCount;
    const afterId = body.after ?? "";
    const st = addStation(d, def, afterId, agentKnown);
    const afterName = d.catalog.stations.find((s) => s.id === afterId)?.name ?? afterId;
    const events = [evt("station.add", projectId, { type: "station", id: st.id }, undefined, { ...st, after: afterName })];
    let gate: unknown;
    if (def.gate) {
      const g = addGate(d, { after: st.id, ...def.gate, kind: def.gate.kind, roles: def.gate.roles, required: def.gate.required });
      gate = g;
      events.push(evt("gate.add", projectId, { type: "gate", id: g.id }, undefined, g));
    }
    return { msg: `${st.name} added to ${project.name}.`, events, extra: { station: st, ...(gate ? { gate } : {}) } };
  });
}

export function removeStationCmd(tx: Tx, a: Actor, projectId: string, stationId: string) {
  return flowCommand(tx, a, projectId, "Remove station", async (d, project) => {
    const busy = await openWorkOrders(tx, a.orgId, projectId, { position: stationId });
    const s = removeStation(d, stationId, busy);
    return { msg: `${s.name} removed from ${project.name}.`, events: [evt("station.remove", projectId, { type: "station", id: s.id }, s.name, null)], extra: {} };
  });
}

export function moveStationCmd(tx: Tx, a: Actor, projectId: string, stationId: string, body: z.infer<typeof MoveBody>) {
  if (body.move === 0) throw invalid("Move a station one place earlier (-1) or later (1).");
  return flowCommand(tx, a, projectId, "Reorder stations", (d) => {
    const r = moveStation(d, stationId, body.move);
    return { msg: `${r.name} moved.`, events: [evt("station.move", projectId, { type: "flow", id: projectId }, r.before.join(">"), r.after.join(">"))], extra: {} };
  });
}

export function addGateCmd(tx: Tx, a: Actor, projectId: string, body: z.infer<typeof GateBody>) {
  return flowCommand(tx, a, projectId, "Add gate", (d, project) => {
    const g = addGate(d, body.def);
    return { msg: `${g.label} ${g.name} added to ${project.name}.`, events: [evt("gate.add", projectId, { type: "gate", id: g.id }, undefined, g)], extra: { gate: g } };
  });
}

export function addBayCmd(tx: Tx, a: Actor, projectId: string, body: z.infer<typeof BayBody>) {
  return flowCommand(tx, a, projectId, "Add bay", (d, project) => {
    const b = addBay(d, body.def);
    return { msg: `${b.name} bay added to ${project.name}.`, events: [evt("bay.add", projectId, { type: "bay", id: b.id }, undefined, b)], extra: { bay: b } };
  });
}

export function addClassCmd(tx: Tx, a: Actor, projectId: string, body: z.infer<typeof ClassBody>) {
  return flowCommand(tx, a, projectId, "Add class", (d, project) => {
    const c = addClass(d, body.def as Parameters<typeof addClass>[1], { regulated: !!project.regulated });
    return { msg: `${c.name} added to ${project.name}.`, events: [evt("class.add", projectId, { type: "class", id: c.id }, undefined, c)], extra: { cls: c } };
  });
}

export function updateClassCmd(tx: Tx, a: Actor, projectId: string, classId: string, patch: z.infer<typeof ClassPatch>) {
  return flowCommand(tx, a, projectId, "Edit class", async (d, project) => {
    const open = await openWorkOrders(tx, a.orgId, projectId, { cls: classId });
    const r = updateClass(d, classId, patch as Partial<WorkClass>, open, { regulated: !!project.regulated });
    return { msg: `${r.after.name} saved.`, events: [evt("class.edit", projectId, { type: "class", id: classId }, r.before, r.after)], extra: {} };
  });
}

/* ---------------------------------------------------------------- approvers -- */

/**
 * S-55: the escalation limit in force is the one saved. Re-arms the timers of the gates already waiting: a new limit measured from when each gate opened (it fires
 * at once when already overdue), cancelled when the limit is 0. An instance that already escalated keeps its outcome.
 */
async function rearmEscalations(tx: Tx, orgId: string, projectId: string, gateId: string, hours: number): Promise<{ waiting: number; changed: number }> {
  const open = (await tx.query<{ id: string; wo_id: string; opened_at: Date }>(
    `select g.id, g.wo_id, g.opened_at from gate_instances g join work_orders w on w.org_id = g.org_id and w.id = g.wo_id
      where g.org_id = $1 and w.project_id = $2 and g.gate_id = $3 and g.status = 'open' and coalesce(g.basis->>'escalated', 'false') <> 'true' order by g.id`, [orgId, projectId, gateId],
  )).rows;
  let changed = 0;
  for (const g of open) {
    await cancel(tx, { orgId, dedupeKey: `escalation:${g.id}` });
    if (hours > 0) {
      await schedule(tx, { orgId, kind: "flow.timer", fireAt: new Date(g.opened_at.getTime() + hours * 3_600_000), subject: g.id, dedupeKey: `escalation:${g.id}`, payload: { kind: "escalation", woId: g.wo_id, gateInstanceId: g.id } });
      changed++;
    }
  }
  return { waiting: open.length, changed };
}

export async function putApprovers(tx: Tx, a: Actor, projectId: string, gateId: string, rule: ApproverRule): Promise<Out<{ version: number; ruleVersion: number }>> {
  await lockProject(tx, a.orgId, projectId, a.ifMatch);
  const project = (await readProject(tx, a.orgId, projectId))!;
  const cfg = project.flow.gates[gateId];
  const def = (await readCatalog(tx, a.orgId)).gates.find((g) => g.id === gateId);
  if (!cfg || cfg.absent || !def) throw invalid(`${projectId} has no gate ${gateId}.`);
  const catalog = await readCatalog(tx, a.orgId);
  const ctx = await ruleContext(tx, a.orgId, projectId, catalog.roles);
  checkRule(gateId, cfg.mode ?? def.kind, rule, ctx, new Set(project.flow.classes.map((c) => c.id)), project.name);
  // S-56: a fallback who cannot approve this gate would leave an escalation reaching nobody. Refused with the way forward.
  if (rule.fallback) {
    const st = await loadPolicyState(tx, a.orgId);
    const fb = st.people.find((x) => x.id === rule.fallback);
    if (!fb) throw invalid(`The fallback approver ${rule.fallback} does not exist.`);
    const d = fb.status === "active" ? can(st, fb.id, def.action || "gate.approve", { project: projectId }) : null;
    if (!d?.allowed) throw invalid(`${fb.name} cannot approve ${def.label} in ${project.name}${d ? `: ${d.reason}` : " (not an active person)"}. Pick a fallback who holds the right to approve gates there, or give ${fb.name} that role first.`);
  }
  const before = project.approvers[gateId] ?? null;
  const ruleVersion = await publishRule(tx, a.orgId, projectId, gateId, rule, a.id);
  const version = await bumpProject(tx, a.orgId, projectId);
  const rearmed = await rearmEscalations(tx, a.orgId, projectId, gateId, Number(rule.escalateH) || 0);
  // Non-blocking: a rule that fewer people can satisfy than it requires saves, and says so.
  const warning = ruleWarning((await readPeople(tx, a.orgId)) as never, project, rule, def.label);
  // The per-class count override is part of the audited change: before and after always carry `classRequired` (empty when none), and the message names it.
  const withCls = (r: ApproverRule | null) => (r ? { ...r, classRequired: r.classRequired ?? {} } : r);
  const clsText = Object.entries(rule.classRequired ?? {}).map(([c, n]) => `${project.flow.classes.find((x) => x.id === c)?.name ?? c} ${n} (base ${rule.required})`).join(", ");
  return {
    msg: `Saved approvers.${gateId}.${clsText ? ` Per-class approvals: ${clsText}.` : ""}${rearmed.waiting ? ` The escalation limit applies to ${rearmed.waiting} waiting work order${rearmed.waiting === 1 ? "" : "s"}.` : ""}${warning ? ` Warning: ${warning}` : ""}`, events: [evt("approvers.edit", projectId, { type: "gaterule", id: `${projectId}:${gateId}` }, jsonOf(withCls(before)), jsonOf(withCls(rule)))],
    extra: { version, ruleVersion, ...(warning ? { warning } : {}) }, changes: ["projects"], project: projectId,
  };
}

/* ------------------------------------------------------------------ members -- */

export async function setMemberRole(tx: Tx, a: Actor, projectId: string, personId: string, roleId: string, add: boolean): Promise<Out<{ version: number }>> {
  const org = a.orgId;
  const project = (await tx.query<{ name: string }>(`select name from projects where org_id = $1 and id = $2 for share`, [org, projectId])).rows[0];
  if (!project) throw notFound("No such project.");
  const person = (await readPeople(tx, org)).find((p) => p.id === personId);
  if (!person) throw notFound("No such person.");
  const role = (await readRoles(tx, org)).find((r) => r.id === roleId);
  if (!role || role.level !== "project") throw invalid("Pick a project-level role.");
  if (person.status === "deactivated") throw invalid(`${person.name} is deactivated.`);
  // Own grants only: a role the person holds through a team is changed on the team (People & teams).
  const had = person.roles.filter((g) => g.scope === projectId && !g.via).map((g) => g.role);
  const has = had.includes(roleId);
  const cur = Number((await tx.query(`select version from people where org_id = $1 and id = $2`, [org, personId])).rows[0].version);
  if (has === add) return { msg: `${person.name} ${add ? "already has" : "does not have"} ${role.name} on ${project.name}.`, events: [], extra: { version: cur }, changes: ["people"], project: projectId };
  if (add) {
    await tx.query(`insert into role_assignments (org_id, id, person_id, role_id, scope_type, project_id, granted_by) values ($1,$2,$3,$4,'project',$5,$6)`, [org, `ra-${randomBytes(6).toString("hex")}`, personId, roleId, projectId, a.id]);
    await tx.query(`insert into project_members (org_id, project_id, person_id) values ($1,$2,$3) on conflict do nothing`, [org, projectId, personId]);
  } else {
    await tx.query(`update role_assignments set revoked_at = now(), updated_at = now() where org_id = $1 and person_id = $2 and role_id = $3 and project_id = $4 and revoked_at is null`, [org, personId, roleId, projectId]);
    if (had.filter((r) => r !== roleId).length === 0) await tx.query(`delete from project_members where org_id = $1 and project_id = $2 and person_id = $3`, [org, projectId, personId]);
  }
  const version = Number((await tx.query(`update people set version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [org, personId])).rows[0].version);
  const after = add ? [...had, roleId] : had.filter((r) => r !== roleId);
  // S-65: the last role on the project ends the person's place on its on-call list.
  const pruned = add ? null : await pruneOncall(tx, org, projectId);
  return {
    msg: `${add ? "Granted " : "Removed "}${role.name}${add ? " to " : " from "}${person.name} on ${project.name}.${pruned?.note ?? ""}`,
    events: [evt(add ? "role.grant" : "role.revoke", projectId, { type: "person", id: personId }, had.join(","), after.join(","), "access"), ...(pruned?.events ?? [])],
    extra: { version }, changes: ["people", "projects", "matrix"], project: projectId,
  };
}

/* ------------------------------------------------------------------ archive -- */

/** Work orders still in play in a project: what an archive holds in place (S-57). */
const LIVE_WOS = `state not in ('done','killed','declined') and source not in ('eval','onboarding')`;
const liveOrders = async (tx: Tx, org: string, projectId: string): Promise<number> =>
  Number((await tx.query<{ n: string }>(`select count(*)::text n from work_orders where org_id = $1 and project_id = $2 and ${LIVE_WOS}`, [org, projectId])).rows[0]?.n ?? 0);

export async function archiveProject(tx: Tx, a: Actor, projectId: string, body: z.infer<typeof ArchiveBody>): Promise<Out<{ version: number; held: number }>> {
  const row = await lockProject(tx, a.orgId, projectId, a.ifMatch);
  if (row.status === "archived") throw conflict(`${row.name} is already archived.`);
  const live = await liveOrders(tx, a.orgId, projectId);
  const impact = live ? ` ${live} live work order${live === 1 ? " is" : "s are"} held in place (nothing new starts); unarchiving releases ${live === 1 ? "it" : "them"}.` : "";
  if (body.confirmText !== row.name) throw invalid(`Type the project name exactly: ${row.name}.${impact}`);
  await tx.query(`update projects set status = 'archived', archived_at = now() where org_id = $1 and id = $2`, [a.orgId, projectId]);
  const version = await bumpProject(tx, a.orgId, projectId);
  const events: EventSpec[] = [evt("project.archive", projectId, { type: "project", id: projectId }, row.status, "archived")];
  const jobs: NonNullable<Out["jobs"]> = [];
  // S-57: live work orders are held with the existing hold mechanism (a project halt with cause `archive`), so no attempt, spend or gate decision continues in a read-only project.
  if (live) {
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${a.orgId}:project:${projectId}`]);
    const have = await tx.query(`select 1 from stops where org_id = $1 and scope_type = 'project' and project_id = $2 and mode = 'halt' and lifted_at is null`, [a.orgId, projectId]);
    if (!have.rowCount) {
      const n = Number((await tx.query(`select count(*)::int + 1 as n from stops where org_id = $1 and starts_with(id, $2)`, [a.orgId, `project:${projectId}:`])).rows[0].n);
      const stopId = `project:${projectId}:${n}`;
      const reason = `${row.name} was archived with ${live} live work order${live === 1 ? "" : "s"}: held in place until it is unarchived.`;
      await tx.query(`insert into stops (org_id, id, scope_type, project_id, mode, reason, cause, set_by, set_at) values ($1,$2,'project',$3,'halt',$4,'archive',$5,$6)`, [a.orgId, stopId, projectId, reason, a.id, a.now]);
      events.push({ type: "stop.set", category: "kill", subject: { type: "project", id: projectId }, projectId, after: { stop: stopId, scope: "project", mode: "halt", cause: "archive", reason, held: live } });
      jobs.push(job("stop.enforce", { stopId, scope: "project", targetId: projectId, mode: "halt" }, { dedupeKey: `stop.enforce:${stopId}:v1`, priority: 100 }));
    }
  }
  return { msg: `${row.name} archived.${impact}`, events, ...(jobs.length ? { jobs } : {}), extra: { version, held: live }, changes: ["projects", "me", ...(live ? ["workOrders", "floor", "home", "stops"] : [])], project: projectId };
}

export async function unarchiveProject(tx: Tx, a: Actor, projectId: string): Promise<Out<{ version: number; status: string; released: number }>> {
  const row = await lockProject(tx, a.orgId, projectId, a.ifMatch);
  if (row.status !== "archived") throw conflict(`${row.name} is not archived.`);
  const repos = (await tx.query<{ onboarding_stage: string }>(`select onboarding_stage from repos where org_id = $1 and project_id = $2`, [a.orgId, projectId])).rows;
  const next = repos.length && repos.every((r) => r.onboarding_stage === "ready") ? "active" : repos.length ? "onboarding" : "new";
  await tx.query(`update projects set status = $3, archived_at = null where org_id = $1 and id = $2`, [a.orgId, projectId, next]);
  const version = await bumpProject(tx, a.orgId, projectId);
  const events: EventSpec[] = [evt("project.unarchive", projectId, { type: "project", id: projectId }, "archived", next)];
  const jobs: NonNullable<Out["jobs"]> = [];
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`stop:${a.orgId}:project:${projectId}`]);
  const held = (await tx.query<{ id: string; version: number }>(`update stops set lifted_by = $3, lifted_at = $4, version = version + 1, updated_at = now() where org_id = $1 and scope_type = 'project' and project_id = $2 and mode = 'halt' and cause = 'archive' and lifted_at is null returning id, version`, [a.orgId, projectId, a.id, a.now])).rows;
  const released = held.length ? await liveOrders(tx, a.orgId, projectId) : 0;
  for (const h of held) {
    events.push({ type: "resume", category: "kill", subject: { type: "project", id: projectId }, projectId, before: { stop: h.id }, after: { stop: h.id, scope: "project", text: "Unarchived: held work orders are released.", released } });
    jobs.push(job("stop.enforce", { stopId: h.id, scope: "project", targetId: projectId, mode: "halt" }, { dedupeKey: `stop.enforce:${h.id}:v${h.version}`, priority: 100 }));
  }
  return { msg: `${row.name} is back (${next}).${released ? ` ${released} held work order${released === 1 ? " is" : "s are"} released.` : ""}`, events, ...(jobs.length ? { jobs } : {}), extra: { version, status: next, released }, changes: ["projects", "me", ...(held.length ? ["workOrders", "floor", "home", "stops"] : [])], project: projectId };
}

/* ---------------------------------------------------------------- templates -- */

const customText = (c: TemplateCustom): string =>
  [...c.stations.map((x) => `station ${x.name}`), ...c.gates.map((x) => `gate ${x.label} ${x.name}`), ...c.bays.map((x) => `bay ${x.name}`), ...c.classes.map((x) => `class ${x.name}`)].join(", ");

export async function saveTemplate(tx: Tx, a: Actor, body: z.infer<typeof TemplateCreate>): Promise<Out<{ template: Template }>> {
  const org = a.orgId;
  let name: string;
  let desc: string;
  let tbody: Record<string, unknown>;
  let from: string;
  if ("fromTemplate" in body) {
    const src = (await readTemplates(tx, org)).find((t) => t.id === body.fromTemplate);
    if (!src) throw notFound("No such template.");
    const { id: _i, name: n, desc: d, builtIn: _b, version: _v, ...rest } = src as Template & { version?: number };
    name = body.name?.trim() || `${n} (copy)`;
    desc = d;
    tbody = JSON.parse(json(rest)) as Record<string, unknown>;
    from = `from ${n}`;
  } else {
    const project = await readProject(tx, org, body.fromProject);
    if (!project) throw notFound("No such project.");
    const st = await visibleTo(tx, a, project.id);
    if (!st) throw notFound("No such project.");
    const catalog = await readCatalog(tx, org);
    const draft = draftOf(project.id, project.flow, project.approvers, catalog);
    tbody = JSON.parse(json(templateBodyFromProject(draft, project))) as Record<string, unknown>;
    name = body.name?.trim() || `${project.name} template`;
    desc = `Saved from ${project.name}`;
    from = `from project ${project.name}`;
  }
  if (name.length < 3) throw invalid("Name the template (3+ characters).");
  const id = `tpl-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  await tx.query(`insert into templates (org_id, id, name, description, builtin, body) values ($1,$2,$3,$4,false,$5::jsonb)`, [org, id, name, desc, json(tbody)]);
  const template = (await readTemplates(tx, org)).find((t) => t.id === id)!;
  const c = customOf(template as Template & { custom?: unknown });
  const n = customCount(c);
  return {
    msg: `Template ${name} saved.${"fromProject" in body ? " Approver rules (counts, escalation hours, conditions, fallback and separation of duties) are kept." : ""}${n ? ` Carries ${n} custom flow entr${n === 1 ? "y" : "ies"}: ${customText(c)}.` : ""}`,
    events: [{ type: "template.save", category: "config", subject: { type: "template", id }, after: `${name} ${from}`, projectId: null }],
    extra: { template }, changes: ["templates"], project: null,
  };
}

/** Can the caller see the project? (Factory roles see every project; others need a project role.) */
async function visibleTo(tx: Tx, a: Actor, projectId: string): Promise<boolean> {
  if (!a.personId) return true;
  const p = (await readPeople(tx, a.orgId)).find((x) => x.id === a.personId);
  if (!p) return false;
  return p.roles.some((r) => r.scope === "factory" || r.scope === projectId);
}

export async function updateTemplate(tx: Tx, a: Actor, id: string, patch: z.infer<typeof TemplatePatch>): Promise<Out<{ version: number }>> {
  const org = a.orgId;
  const row = (await tx.query<{ name: string; description: string; builtin: boolean; body: Record<string, unknown>; version: number }>(`select name, description, builtin, body, version from templates where org_id = $1 and id = $2 for update`, [org, id])).rows[0];
  if (!row) throw notFound("No such template.");
  if (a.ifMatch !== null && a.ifMatch !== row.version) throw refuse("stale", "This changed since you loaded it. Reload and try again.");
  if (row.builtin) throw conflict("Built-in templates are read-only. Duplicate it to change it.");
  const catalog = await readCatalog(tx, org);
  checkTemplatePatch(patch, catalog);
  const { name, desc, ...rest } = patch;
  if (name !== undefined && name.trim().length < 3) throw invalid("Name the template (3+ characters).");
  const pick = (b: Record<string, unknown>) => ({ name: undefined as unknown, stationsOff: b.stationsOff, gatesOff: b.gatesOff, classesSkip: b.classesSkip });
  const before = { ...pick(row.body), name: row.name };
  const nextBody = { ...row.body, ...JSON.parse(json(rest)) } as Record<string, unknown>;
  if (rest.approverPreset !== undefined) delete nextBody.approvers; // choosing a preset replaces the rules saved from a project
  const version = Number(
    (await tx.query(`update templates set name = $3, description = $4, body = $5::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`, [org, id, name?.trim() ?? row.name, desc ?? row.description, json(nextBody)])).rows[0].version,
  );
  return {
    msg: "Template saved.",
    events: [{ type: "template.edit", category: "config", subject: { type: "template", id }, before: jsonOf(before), after: jsonOf({ ...pick(nextBody), name: name?.trim() ?? row.name }), projectId: null }],
    extra: { version }, changes: ["templates"], project: null,
  };
}

/* -------------------------------------------------------------- saved views -- */

export interface SavedViewOut {
  id: string;
  name: string;
  screen: string;
  project: string | null;
  s: Record<string, unknown>;
  version: number;
}

const viewRow = (r: { id: string; name: string; screen: string; project_id: string | null; body: unknown; version: number }): SavedViewOut => ({ id: r.id, name: r.name, screen: r.screen, project: r.project_id, s: (r.body as Record<string, unknown>) ?? {}, version: r.version });

export async function listViews(db: Pick<Tx, "query">, orgId: string, personId: string, screen?: string): Promise<SavedViewOut[]> {
  const { rows } = await db.query(`select id, name, screen, project_id, body, version from saved_views where org_id = $1 and person_id = $2 and ($3::text is null or screen = $3) order by created_at, id`, [orgId, personId, screen ?? null]);
  return rows.map(viewRow);
}

const needPerson = (a: Actor): string => {
  if (!a.personId) throw refuse("denied", "Saved views belong to a signed-in person.");
  return a.personId;
};

export async function createView(tx: Tx, a: Actor, body: z.infer<typeof ViewCreate>): Promise<Out<{ view: SavedViewOut }>> {
  const who = needPerson(a);
  const name = body.name.trim();
  if (name.length < 2) throw invalid("Name the view (2+ characters).");
  if (body.project && !(await visibleTo(tx, a, body.project))) throw notFound("No such project.");
  const id = `v-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  try {
    await tx.query("savepoint v");
    await tx.query(`insert into saved_views (org_id, id, person_id, project_id, screen, name, body) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [a.orgId, id, who, body.project ?? null, body.screen, name, json(body.s)]);
  } catch (e) {
    await tx.query("rollback to savepoint v");
    if ((e as { code?: string }).code === "23505") throw conflict(`You already have a view called ${name}.`);
    throw e;
  }
  const view = (await listViews(tx, a.orgId, who)).find((v) => v.id === id)!;
  return { msg: `View ${name} saved.`, events: [{ type: "view.save", category: "config", subject: { type: "saved_view", id }, after: name, projectId: null }], extra: { view }, changes: ["savedViews"], project: null, audience: [who] };
}

export async function updateView(tx: Tx, a: Actor, id: string, patch: z.infer<typeof ViewPatch>): Promise<Out<{ view: SavedViewOut }>> {
  const who = needPerson(a);
  const row = (await tx.query<{ name: string; body: Record<string, unknown>; version: number }>(`select name, body, version from saved_views where org_id = $1 and id = $2 and person_id = $3 for update`, [a.orgId, id, who])).rows[0];
  if (!row) throw notFound("No such saved view.");
  if (a.ifMatch !== null && a.ifMatch !== row.version) throw refuse("stale", "This changed since you loaded it. Reload and try again.");
  const name = patch.name?.trim() ?? row.name;
  if (name.length < 2) throw invalid("Name the view (2+ characters).");
  try {
    await tx.query("savepoint v");
    await tx.query(`update saved_views set name = $4, body = $5::jsonb, version = version + 1, updated_at = now() where org_id = $1 and id = $2 and person_id = $3`, [a.orgId, id, who, name, json(patch.s ?? row.body)]);
  } catch (e) {
    await tx.query("rollback to savepoint v");
    if ((e as { code?: string }).code === "23505") throw conflict(`You already have a view called ${name}.`);
    throw e;
  }
  const view = (await listViews(tx, a.orgId, who)).find((v) => v.id === id)!;
  const renamed = name !== row.name;
  return { msg: renamed ? `View renamed to ${name}.` : `View ${name} updated.`, events: [{ type: "view.edit", category: "config", subject: { type: "saved_view", id }, before: row.name, after: name, projectId: null }], extra: { view }, changes: ["savedViews"], project: null, audience: [who] };
}

export async function deleteView(tx: Tx, a: Actor, id: string): Promise<Out> {
  const who = needPerson(a);
  const row = (await tx.query<{ name: string; version: number }>(`select name, version from saved_views where org_id = $1 and id = $2 and person_id = $3 for update`, [a.orgId, id, who])).rows[0];
  if (!row) throw notFound("No such saved view.");
  if (a.ifMatch !== null && a.ifMatch !== row.version) throw refuse("stale", "This changed since you loaded it. Reload and try again.");
  await tx.query(`delete from saved_views where org_id = $1 and id = $2`, [a.orgId, id]);
  return { msg: `View ${row.name} deleted.`, events: [{ type: "view.delete", category: "config", subject: { type: "saved_view", id }, before: row.name, projectId: null }], changes: ["savedViews"], project: null, audience: [who] };
}

export { parseConfigEdit };
export type { ProjectFlow };
