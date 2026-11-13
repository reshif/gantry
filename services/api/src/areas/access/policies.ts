import { policyText, type Policy } from "@gantry/domain";
import type { Tx } from "@gantry/db";
import { conflict, invalid, notFound } from "../../core/errors.js";
import type { CommandResult } from "../../core/command.js";
import { lockOrgConfig, stateIn } from "./config.js";
import type { PolicyInput } from "./schemas.js";

/** Policies the engine owns: freeze rules come from the freeze list, the agent autonomy rule from agent settings. They can only be switched on or off. */
export const FIXED_POLICIES: Readonly<Record<string, string>> = {
  "POL-110": "Freeze rules come from the freeze list; only enable or disable this policy.",
  "POL-112": "Agent autonomy rule; only enable or disable this policy.",
};

export const policyVersion = async (tx: Tx, orgId: string, id: string): Promise<number | null> =>
  (await tx.query(`select current_version from policies where org_id = $1 and id = $2 and deleted_at is null`, [orgId, id])).rows[0]?.current_version ?? null;

interface Loaded {
  policy: Policy;
  version: number;
}

async function load(tx: Tx, orgId: string, id: string): Promise<Loaded> {
  const st = await stateIn(tx, orgId);
  const policy = st.policies.find((p) => p.id === id);
  if (!policy) throw notFound("No such policy.");
  return { policy, version: Number((policy as Policy & { version?: number }).version ?? 1) };
}

/** Role ids a policy may name: real roles, "*" (anyone) or "agents". Action ids must be in the catalogue. */
function validate(st: Awaited<ReturnType<typeof stateIn>>, body: PolicyInput): void {
  const roles = new Set(st.catalog.roles.map((r) => r.id));
  for (const r of body.roles) if (r !== "*" && r !== "agents" && !roles.has(r)) throw invalid(`There is no role ${r}.`);
  const actions = new Set(st.catalog.actions.map((a) => a.id));
  for (const a of body.actions) if (!actions.has(a)) throw invalid(`There is no action ${a}.`);
  const projects = new Set(st.projects.map((p) => p.id));
  for (const p of body.where.projects ?? []) if (!projects.has(p)) throw invalid(`There is no project ${p}.`);
  if (body.when && !body.when.days.length) throw invalid("Pick at least one day.");
  if (body.when && body.when.to !== "24:00" && body.when.from >= body.when.to) throw invalid("'To' must be after 'From'.");
}

const bodyOf = (p: PolicyInput, extra: { id: string; enabled: boolean; custom: boolean }): Record<string, unknown> => {
  const { note: _n, ...rest } = p;
  return { ...rest, ...extra };
};

async function nextId(tx: Tx, orgId: string): Promise<string> {
  const { rows } = await tx.query<{ n: number | null }>(`select max((substring(id from 5))::int) as n from policies where org_id = $1 and id ~ '^POL-[0-9]+$'`, [orgId]);
  return `POL-${Math.max(100, rows[0]?.n ?? 100) + 1}`;
}

async function writeVersion(tx: Tx, orgId: string, id: string, version: number, body: Record<string, unknown>, note: string, by: string): Promise<void> {
  await tx.query(`insert into policy_versions (org_id, policy_id, version, body, note, published_at, published_by) values ($1,$2,$3,$4::jsonb,$5, now(), $6)`, [orgId, id, version, JSON.stringify(body), note, by]);
}

/** Create a policy. Policy ids are never reused: a deleted policy keeps its row. */
export async function createPolicy(tx: Tx, orgId: string, by: string, body: PolicyInput): Promise<CommandResult<{ id: string; version: number }>> {
  await lockOrgConfig(tx, orgId);
  const st = await stateIn(tx, orgId);
  validate(st, body);
  const id = await nextId(tx, orgId);
  const enabled = body.enabled !== false;
  await tx.query(`insert into policies (org_id, id, name, kind, enabled, current_version) values ($1,$2,$3,$4,$5,1)`, [orgId, id, body.name, body.effect, enabled]);
  const stored = bodyOf(body, { id, enabled, custom: true });
  await writeVersion(tx, orgId, id, 1, stored, body.note ?? "Created", by);
  const sentence = policyText.sentence(st, stored as unknown as Policy);
  return {
    msg: `${id} added.`,
    events: [{ type: "policy.create", category: "access", subject: { type: "policy", id }, before: null, after: sentence, projectId: null }],
    extra: { id, version: 1 },
    changes: ["policies", "matrix"],
    project: null,
  };
}

export async function updatePolicy(tx: Tx, orgId: string, by: string, id: string, body: PolicyInput): Promise<CommandResult<{ id: string; version: number }>> {
  await lockOrgConfig(tx, orgId);
  const { policy, version } = await load(tx, orgId, id);
  if (FIXED_POLICIES[id]) throw conflict(FIXED_POLICIES[id]!);
  const st = await stateIn(tx, orgId);
  validate(st, body);
  const enabled = body.enabled ?? policy.enabled;
  const custom = (policy as Policy & { custom?: boolean }).custom === true;
  const stored = bodyOf(body, { id, enabled, custom });
  const next = version + 1;
  await tx.query(`update policies set name = $3, kind = $4, enabled = $5, current_version = $6, updated_at = now() where org_id = $1 and id = $2`, [orgId, id, body.name, body.effect, enabled, next]);
  await writeVersion(tx, orgId, id, next, stored, body.note ?? "Edited", by);
  return {
    msg: `${id} saved.`,
    events: [{ type: "policy.edit", category: "access", subject: { type: "policy", id }, before: policyText.sentence(st, policy), after: policyText.sentence(st, stored as unknown as Policy), projectId: null }],
    extra: { id, version: next },
    changes: ["policies", "matrix"],
    project: null,
  };
}

export async function setPolicyEnabled(tx: Tx, orgId: string, by: string, id: string, on: boolean): Promise<CommandResult<{ id: string; version: number }>> {
  await lockOrgConfig(tx, orgId);
  const { policy, version } = await load(tx, orgId, id);
  if (policy.enabled === on) return { msg: `${id} is already ${on ? "enabled" : "disabled"}.`, events: [], extra: { id, version }, changes: ["policies"], project: null };
  const next = version + 1;
  const { version: _v, ...body } = policy as Policy & { version?: number };
  await tx.query(`update policies set enabled = $3, current_version = $4, updated_at = now() where org_id = $1 and id = $2`, [orgId, id, on, next]);
  await writeVersion(tx, orgId, id, next, { ...body, enabled: on }, on ? "Enabled" : "Disabled", by);
  return {
    msg: on ? `${id} enabled.` : `${id} disabled. It no longer affects decisions.`,
    events: [{ type: "policy.edit", category: "access", subject: { type: "policy", id }, before: !on, after: on, projectId: null }],
    extra: { id, version: next },
    changes: ["policies", "matrix"],
    project: null,
  };
}

export async function deletePolicy(tx: Tx, orgId: string, id: string): Promise<CommandResult> {
  await lockOrgConfig(tx, orgId);
  const { policy } = await load(tx, orgId, id);
  if ((policy as Policy & { custom?: boolean }).custom !== true) throw conflict(`${id} is built in. You can disable it, not delete it.`);
  const st = await stateIn(tx, orgId);
  await tx.query(`update policies set deleted_at = now(), enabled = false, updated_at = now() where org_id = $1 and id = $2`, [orgId, id]);
  return {
    msg: `${id} deleted.`,
    events: [{ type: "policy.delete", category: "access", subject: { type: "policy", id }, before: policyText.sentence(st, policy), after: "deleted", projectId: null }],
    changes: ["policies", "matrix"],
    project: null,
  };
}
