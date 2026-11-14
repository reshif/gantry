import type { Queryable } from "@gantry/db";
import { loadRouting, modelFacts, modelRows, vendorFacts, vendorRows } from "./store.js";
import { resolveModel, type Resolution, type ResolveInput } from "./resolve.js";

/** Everything the resolver needs that does not depend on the request. */
export async function loadFacts(db: Queryable, orgId: string): Promise<Pick<ResolveInput, "routing" | "vendors" | "models">> {
  const [routing, vs, ms] = await Promise.all([loadRouting(db, orgId), vendorRows(db, orgId), modelRows(db, orgId)]);
  return { routing, vendors: vs.map(vendorFacts), models: ms.map(modelFacts) };
}

/** Residency tags of a repo: its own tags, plus "regulated" for a regulated project (legacy repoTags). */
export async function repoTagsFor(db: Queryable, orgId: string, repoId: string | null | undefined): Promise<{ tags: string[]; project: string | null } | null> {
  if (!repoId) return null;
  const { rows } = await db.query<{ tags: string[]; project_id: string; regulated: boolean }>(
    `select r.tags, r.project_id, p.regulated from repos r join projects p on p.org_id = r.org_id and p.id = r.project_id where r.org_id = $1 and r.id = $2`,
    [orgId, repoId],
  );
  const r = rows[0];
  if (!r) return null;
  const tags = [...(r.tags ?? [])];
  if (r.regulated && !tags.includes("regulated")) tags.push("regulated");
  return { tags, project: r.project_id };
}

export interface RouteRequest {
  station: string;
  woClass?: string | undefined;
  project?: string | undefined;
  repoId?: string | null | undefined;
  pinned?: string | null | undefined;
  projectAllowedVendors?: string[] | undefined;
  projectCrossModel?: boolean | undefined;
}

export async function resolveFor(db: Queryable, orgId: string, q: RouteRequest): Promise<Resolution> {
  const [facts, repo] = await Promise.all([loadFacts(db, orgId), repoTagsFor(db, orgId, q.repoId)]);
  return resolveModel({ ...facts, station: q.station, woClass: q.woClass, project: q.project ?? repo?.project ?? undefined, repoTags: repo?.tags, pinned: q.pinned, projectAllowedVendors: q.projectAllowedVendors, projectCrossModel: q.projectCrossModel });
}
