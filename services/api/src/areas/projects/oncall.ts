/**
 * On call, per project (owner decision 7, 2026-11-15). A project's admins choose who is on call for it; a Factory Admin always
 * counts and is never listed. Nobody can put themselves on call: a person who is on call may only hand over to someone who
 * holds a role on the same project. Every change is one audited event with the list before and after.
 */
import { isFactoryAdminPerson, type Person } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import type { Actor, CommandResult, EventSpec } from "../../core/command.js";
import { conflict, invalid, notFound, refuse } from "../../core/errors.js";
import { readPeople } from "../../core/read/index.js";

type Out = CommandResult<{ oncall: string[]; version: number }>;

async function load(tx: Tx, orgId: string, projectId: string): Promise<{ name: string; list: string[]; people: Person[] }> {
  const row = (await tx.query<{ name: string; oncall: unknown }>(`select name, config -> 'oncall' as oncall from projects where org_id = $1 and id = $2 for update`, [orgId, projectId])).rows[0];
  if (!row) throw notFound("No such project.");
  const list = Array.isArray(row.oncall) ? row.oncall.filter((x): x is string => typeof x === "string") : [];
  return { name: row.name, list, people: await readPeople(tx, orgId) };
}

/** Who may be on call for a project: active people holding a role on it (directly, through a team, or at factory level). */
function eligible(people: Person[], projectId: string, id: string): Person {
  const p = people.find((x) => x.id === id);
  if (!p) throw invalid(`There is no person ${id}.`);
  if (p.status !== "active") throw invalid(`${p.name} is not active, so they can't be on call.`);
  if (!p.roles.some((g) => g.scope === projectId || g.scope === "factory")) throw invalid(`${p.name} holds no role on this project. Grant a role first, then put them on call.`);
  return p;
}

async function save(tx: Tx, orgId: string, projectId: string, list: string[]): Promise<number> {
  const r = await tx.query<{ version: number }>(
    `update projects set config = jsonb_set(config, '{oncall}', $3::jsonb), version = version + 1, updated_at = now() where org_id = $1 and id = $2 returning version`,
    [orgId, projectId, JSON.stringify(list)],
  );
  return Number(r.rows[0]!.version);
}

const names = (people: Person[], ids: string[]): string => ids.map((id) => people.find((p) => p.id === id)?.name ?? id).join(", ") || "nobody";

/** A project admin sets the whole list. Factory Admins are dropped from it: they are always on call. */
export async function setProjectOncall(tx: Tx, a: Actor, projectId: string, ids: string[]): Promise<Out> {
  const { name, list, people } = await load(tx, a.orgId, projectId);
  const next = [...new Set(ids)].filter((id) => !isFactoryAdminPerson(eligible(people, projectId, id)));
  if (next.length === list.length && next.every((x, i) => x === list[i])) {
    const version = Number((await tx.query<{ version: number }>(`select version from projects where org_id = $1 and id = $2`, [a.orgId, projectId])).rows[0]!.version);
    return { msg: `No change: on call for ${name} is ${names(people, list)}.`, events: [], extra: { oncall: list, version }, changes: [], project: projectId };
  }
  const version = await save(tx, a.orgId, projectId, next);
  return {
    msg: `On call for ${name}: ${names(people, next)}. Factory Admins are always on call.`,
    events: [{ type: "project.oncall", category: "access", subject: { type: "project", id: projectId }, projectId, before: list, after: next }],
    extra: { oncall: next, version },
    changes: ["projects", "people", "matrix"],
    project: projectId,
  };
}

/** The person on call hands over to someone eligible on the same project. Nobody can hand themselves on. */
export async function handOverOncall(tx: Tx, a: Actor, projectId: string, to: string): Promise<Out> {
  const me = a.personId;
  if (!me) throw refuse("denied", "Only a person who is on call can hand over.");
  const { name, list, people } = await load(tx, a.orgId, projectId);
  if (!list.includes(me)) throw conflict(`You are not on call for ${name}, so there is nothing to hand over. A project admin chooses who is on call.`);
  // S-65: handing over is for someone who still holds a role on the project (or is a Factory Admin).
  const self = people.find((x) => x.id === me);
  if (!self || !self.roles.some((g) => g.scope === projectId || g.scope === "factory")) throw refuse("denied", `You hold no role on ${name}, so you cannot change who is on call for it. A project admin chooses who is on call.`);
  if (to === me) throw invalid("Pick someone else to hand over to.");
  const target = eligible(people, projectId, to);
  if (isFactoryAdminPerson(target)) throw invalid(`${target.name} is a Factory Admin and is always on call. Pick someone else, or ask a project admin to take you off.`);
  const next = [...new Set(list.map((x) => (x === me ? to : x)))];
  const version = await save(tx, a.orgId, projectId, next);
  return {
    msg: `You handed on-call for ${name} to ${target.name}.`,
    events: [{ type: "project.oncall_handover", category: "access", subject: { type: "project", id: projectId }, projectId, before: list, after: next }],
    extra: { oncall: next, version },
    changes: ["projects", "people", "matrix"],
    project: projectId,
  };
}

/**
 * S-65: only someone who holds a role on the project is on its on-call list. When a role or team grant ends, whoever no longer holds any role on the project is taken off the list
 * (a Factory Admin or any factory-level role still counts as a role here, as in `eligible`). Returns the audit events and a sentence for the response (empty when nothing changed).
 */
export async function pruneOncall(tx: Tx, orgId: string, projectId: string): Promise<{ events: EventSpec[]; note: string; removed: string[]; empty: boolean }> {
  const row = (await tx.query<{ name: string; oncall: unknown }>(`select name, config -> 'oncall' as oncall from projects where org_id = $1 and id = $2 for update`, [orgId, projectId])).rows[0];
  const list = row && Array.isArray(row.oncall) ? row.oncall.filter((x): x is string => typeof x === "string") : [];
  if (!row || !list.length) return { events: [], note: "", removed: [], empty: false };
  const people = await readPeople(tx, orgId);
  const keep = list.filter((id) => people.find((p) => p.id === id)?.roles.some((g) => g.scope === projectId || g.scope === "factory"));
  if (keep.length === list.length) return { events: [], note: "", removed: [], empty: false };
  const removed = list.filter((id) => !keep.includes(id));
  await save(tx, orgId, projectId, keep);
  return {
    events: [{ type: "project.oncall_pruned", category: "access", subject: { type: "project", id: projectId }, projectId, before: list, after: keep }],
    note: ` ${names(people, removed)} no longer holds a role on ${row.name}, so they are off its on-call list.${keep.length ? "" : ` The on-call list for ${row.name} is now empty (Factory Admins are always on call); a project admin should choose someone.`}`,
    removed, empty: keep.length === 0,
  };
}
