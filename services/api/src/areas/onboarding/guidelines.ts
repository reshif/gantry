/** Versioned onboarding guidelines (spec 8.6): the factory list and each project's additions. A version is immutable once published; saving adds the next one. */
import type { Queryable, Tx } from "@gantry/db";
import { DEFAULT_ORG_GUIDELINES, type GuidelineItem, type OrgGuidelines, type ProjectGuidelines } from "@gantry/domain";
import { z } from "zod";
import type { Actor, CommandResult } from "../../core/command.js";
import { conflict, invalid, stale } from "../../core/errors.js";

const Item = z.object({ id: z.string().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/), text: z.string().trim().min(1).max(500), required: z.boolean() }).strict();
const unique = (items: { id: string }[]): boolean => new Set(items.map((i) => i.id)).size === items.length;
const Note = z.string().trim().min(3, "Add a short change note.").max(300);

export const OrgPatch = z.object({ items: z.array(Item).max(60).refine(unique, "Guideline ids must be unique.").optional(), may: z.string().trim().max(2000).optional(), mayNot: z.string().trim().max(2000).optional() }).strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to save.");
export const ProjectPatch = z.object({ items: z.array(Item).max(60).refine(unique, "Guideline ids must be unique.").optional(), notes: z.string().trim().max(2000).optional() }).strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to save.");
export const OrgBody = z.object({ patch: OrgPatch, note: Note }).strict();
export const ProjectBody = z.object({ patch: ProjectPatch, note: Note }).strict();

interface Row { version: number; body: { items?: GuidelineItem[]; may?: string; mayNot?: string; notes?: string; unavailable?: boolean }; note: string; published_at: Date | null; published_by: string | null }

const SELECT = `select version, body, note, published_at, published_by from guideline_versions where org_id = $1 and scope = $2 and project_id is not distinct from $3 and published_at is not null order by version`;

/** The factory guidelines. An org that never saved any has the built-in list as version 0. */
export async function readOrgGuidelines(db: Queryable, orgId: string): Promise<OrgGuidelines> {
  const rows = (await db.query<Row>(SELECT, [orgId, "org", null])).rows;
  const last = rows.at(-1);
  if (!last) return { version: 0, by: "system", at: 0, items: DEFAULT_ORG_GUIDELINES.items, may: DEFAULT_ORG_GUIDELINES.may, mayNot: DEFAULT_ORG_GUIDELINES.mayNot, history: [] };
  return {
    version: last.version, by: last.published_by ?? "system", at: last.published_at?.getTime() ?? 0,
    items: last.body.items ?? [], may: last.body.may ?? "", mayNot: last.body.mayNot ?? "",
    history: rows.map((r) => ({ v: r.version, at: r.published_at?.getTime() ?? 0, by: r.published_by ?? "system", note: r.note })),
  };
}

export async function readProjectGuidelines(db: Queryable, orgId: string, projectId: string): Promise<ProjectGuidelines | null> {
  const rows = (await db.query<Row>(SELECT, [orgId, "project", projectId])).rows;
  const last = rows.at(-1);
  if (!last) return null;
  return { version: last.version, items: last.body.items ?? [], notes: last.body.notes ?? "", history: rows.map((r) => ({ v: r.version, at: r.published_at?.getTime() ?? 0, by: r.published_by ?? "system", note: r.note })) };
}

type Out = CommandResult<Record<string, unknown>>;

async function nextVersion(tx: Tx, orgId: string, scope: "org" | "project", projectId: string | null): Promise<{ next: number; current: Row | null }> {
  // One writer at a time per list: the unique index would refuse the loser, this makes it wait and then see the new version.
  await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`guidelines:${orgId}:${scope}:${projectId ?? ""}`]);
  const rows = (await tx.query<Row>(SELECT, [orgId, scope, projectId])).rows;
  return { next: (rows.at(-1)?.version ?? 0) + 1, current: rows.at(-1) ?? null };
}

export async function saveOrgGuidelines(tx: Tx, a: Actor, b: z.infer<typeof OrgBody>): Promise<Out> {
  const { next, current } = await nextVersion(tx, a.orgId, "org", null);
  if (a.ifMatch !== null && a.ifMatch !== (current?.version ?? 0)) throw stale();
  const cur = current?.body ?? { items: DEFAULT_ORG_GUIDELINES.items, may: DEFAULT_ORG_GUIDELINES.may, mayNot: DEFAULT_ORG_GUIDELINES.mayNot };
  const body = { items: b.patch.items ?? cur.items ?? [], may: b.patch.may ?? cur.may ?? "", mayNot: b.patch.mayNot ?? cur.mayNot ?? "" };
  if (JSON.stringify(body) === JSON.stringify({ items: cur.items ?? [], may: cur.may ?? "", mayNot: cur.mayNot ?? "" })) throw conflict("Nothing changed. Edit a guideline first.");
  if (!body.items.length) throw invalid("Keep at least one guideline.");
  await tx.query(`insert into guideline_versions (org_id, scope, project_id, version, body, note, published_at, published_by) values ($1,'org',null,$2,$3::jsonb,$4,$5,$6)`, [a.orgId, next, JSON.stringify(body), b.note, a.now, a.id]);
  return {
    msg: `Guidelines saved as v${next}.`,
    events: [{ type: "guidelines.edit", category: "onboarding", subject: { type: "guidelines", id: "onboarding" }, projectId: null, before: { version: current?.version ?? 0, items: cur.items, may: cur.may, mayNot: cur.mayNot }, after: { version: next, ...body, note: b.note } }],
    extra: { version: next }, changes: ["guidelines", "audit"], project: null,
  };
}

export async function saveProjectGuidelines(tx: Tx, a: Actor, projectId: string, projectName: string, b: z.infer<typeof ProjectBody>): Promise<Out> {
  const { next, current } = await nextVersion(tx, a.orgId, "project", projectId);
  if (a.ifMatch !== null && a.ifMatch !== (current?.version ?? 0)) throw stale();
  const cur = current?.body ?? { items: [], notes: "" };
  const body = { items: b.patch.items ?? cur.items ?? [], notes: b.patch.notes ?? cur.notes ?? "" };
  if (JSON.stringify(body) === JSON.stringify({ items: cur.items ?? [], notes: cur.notes ?? "" })) throw conflict("Nothing changed. Edit a guideline first.");
  await tx.query(`insert into guideline_versions (org_id, scope, project_id, version, body, note, published_at, published_by) values ($1,'project',$2,$3,$4::jsonb,$5,$6,$7)`, [a.orgId, projectId, next, JSON.stringify(body), b.note, a.now, a.id]);
  return {
    msg: `${projectName} guidelines saved as v${next}.`,
    events: [{ type: "guidelines.edit", category: "onboarding", subject: { type: "guidelines", id: projectId }, projectId, before: { version: current?.version ?? 0, items: cur.items, notes: cur.notes }, after: { version: next, ...body, note: b.note } }],
    extra: { version: next }, changes: ["guidelines", "projects", "audit"], project: projectId,
  };
}

/** The guideline versions an assessment is made against, and the items it checks. */
export async function guidelinesFor(db: Queryable, orgId: string, projectId: string): Promise<{ org: OrgGuidelines; project: ProjectGuidelines | null }> {
  const [org, project] = await Promise.all([readOrgGuidelines(db, orgId), readProjectGuidelines(db, orgId, projectId)]);
  return { org, project };
}
