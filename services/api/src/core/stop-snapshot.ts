/**
 * Break-glass policy snapshot for the stop path (spec 8.5, I7).
 *
 * Halt, kill, resume and restore must work when policy data is unreadable. The API stores the part of the policy state those decisions need
 * (people and their role grants, the role matrix, policies, the catalogue's roles and actions, project and repo names) in `stop_policy_snapshot`
 * after every successful load, skipping the write when nothing changed. Only the stop path reads it, and only after the normal load failed.
 * Active stops are always read live from `stops` (the table the stop path owns), never from the snapshot.
 *
 * Limits: the snapshot is as old as the last successful load, so a role revoked after it stays effective for stop commands while the policy tables
 * are down; each such decision is recorded with the snapshot's age. Freezes and the flow engine's data are not in it. With no snapshot yet
 * (a fresh install whose first load fails) the stop fails like any other command.
 */
import { createHash } from "node:crypto";
import type { Catalog, Matrix, Person, Policy, PolicyState } from "@gantry/domain";
import type { Queryable } from "@gantry/db";
import type pg from "pg";
import type { PolicyStateLoaded } from "./context.js";
import { foldProjects, foldRepos, type ProjectRow, type RepoRow } from "./read/state.js";
import { readActiveStops } from "./read/index.js";

export interface StopSnapshot {
  people: Array<Pick<Person, "id" | "name" | "status" | "oncall" | "roles">>;
  matrix: Matrix;
  policies: Policy[];
  catalog: Pick<Catalog, "roles" | "actions">;
  projects: ProjectRow[];
  repos: RepoRow[];
}

export function snapshotOf(st: PolicyStateLoaded): StopSnapshot {
  return {
    people: st.people.map((p) => ({ id: p.id, name: p.name, status: p.status, oncall: p.oncall, roles: p.roles })),
    matrix: st.matrix,
    policies: st.policies,
    catalog: { roles: st.catalog.roles, actions: st.catalog.actions },
    projects: st.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, regulated: !!p.regulated })),
    repos: st.repos.map((r) => ({ id: r.id, name: r.name, project_id: r.project })),
  };
}

const lastDigest = new Map<string, string>();

/** After a successful policy load: stores the snapshot when it changed. Never throws; the snapshot is best effort and must not slow or fail a request. */
export async function refreshStopSnapshot(pool: pg.Pool, orgId: string, st: PolicyStateLoaded): Promise<void> {
  try {
    const body = JSON.stringify(snapshotOf(st));
    const digest = createHash("sha256").update(body).digest("hex");
    if (lastDigest.get(orgId) === digest) return;
    await pool.query(
      `insert into stop_policy_snapshot (org_id, snapshot, digest, taken_at) values ($1, $2::jsonb, $3, now())
       on conflict (org_id) do update set snapshot = excluded.snapshot, digest = excluded.digest, taken_at = excluded.taken_at where stop_policy_snapshot.digest <> excluded.digest`,
      [orgId, body, digest],
    );
    lastDigest.set(orgId, digest);
  } catch {
    // Next successful load tries again.
  }
}

export interface SnapshotLoad {
  state: PolicyStateLoaded;
  takenAt: Date;
  snapshot: StopSnapshot;
}

export async function readStopSnapshot(db: Queryable, orgId: string): Promise<{ snapshot: StopSnapshot; takenAt: Date } | null> {
  const { rows } = await db.query<{ snapshot: StopSnapshot; taken_at: Date }>(`select snapshot, taken_at from stop_policy_snapshot where org_id = $1`, [orgId]);
  return rows[0] ? { snapshot: rows[0].snapshot, takenAt: rows[0].taken_at } : null;
}

/** Policy state rebuilt from the snapshot plus the live stops. Null when there is no snapshot. */
export async function loadStopSnapshot(db: Queryable, orgId: string): Promise<SnapshotLoad | null> {
  const s = await readStopSnapshot(db, orgId);
  if (!s) return null;
  const stops = await readActiveStops(db, orgId);
  const sn = s.snapshot;
  const f = stops.find((x) => x.scope === "factory" && x.mode === "kill");
  const state: PolicyStateLoaded = {
    people: sn.people.map((p) => ({ title: "", email: "", teams: [], github: "", away: null, ...p })) as Person[],
    matrix: sn.matrix,
    policies: sn.policies,
    freezes: [],
    projects: foldProjects(sn.projects, stops),
    repos: foldRepos(sn.repos, stops),
    stops: { factory: f ? { by: f.by, at: f.at, reason: f.reason, scope: "factory", mode: f.inFlight ?? "hold" } : null },
    catalog: sn.catalog as Catalog,
    activeStops: stops,
  } as PolicyState & { catalog: Catalog; activeStops: typeof stops };
  return { state, takenAt: s.takenAt, snapshot: sn };
}
