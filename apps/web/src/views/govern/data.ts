/**
 * Shared data and helpers for the People, Access and Security screens: the teams read, every repo the viewer can see
 * (one call per visible project), a policy-state shim so the domain's policy wording works on API data, and the
 * result handler that turns a refused command into a toast (and a step-up redirect when the server asks for one).
 */
import { useQueries } from "@tanstack/react-query";
import { useCallback } from "react";
import { policyText, type Catalog, type Policy, type PolicyState, type Repo } from "@gantry/domain";
import { api, get, type ApiResult } from "../../api/client";
import { useAccessMatrix, useMe, usePeople, usePolicies } from "../../api/queries";
import { qk } from "../../api/keys";
import { useUI } from "../../ui/overlay-context";

export { useTeams } from "../../api/queries";

/** Every repo in the projects the viewer can see. A project whose repo list cannot be read contributes nothing. */
export function useAllRepos(): { repos: Repo[]; pending: boolean } {
  const me = useMe();
  const ids = (me?.projects ?? []).map((p) => p.id);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: qk.repos(id),
      queryFn: async () => {
        try {
          return await get<Repo[]>(api(`projects/${encodeURIComponent(id)}/repos`));
        } catch {
          return [] as Repo[];
        }
      },
    })),
  });
  return { repos: results.flatMap((r) => r.data ?? []), pending: results.some((r) => r.isPending) };
}

/** What the domain's policy wording needs: roles, actions and project names. */
export function usePolicyWording() {
  const me = useMe();
  const m = useAccessMatrix().data;
  const policies = usePolicies().data ?? [];
  const people = usePeople().data ?? [];
  const catalog = m ? ({ roles: m.roles, actions: m.actions } as Pick<Catalog, "roles" | "actions">) : undefined;
  const state = { people, matrix: m?.matrix ?? {}, policies, freezes: [], projects: me?.projects ?? [], repos: [], ...(catalog ? { catalog } : {}) } as unknown as PolicyState;
  return {
    state,
    sentence: (p: Policy) => policyText.sentence(state, p),
    roles: (p: Policy) => policyText.roles(state, p),
    where: (p: Policy) => policyText.where(state, p),
    when: (w: Policy["when"]) => policyText.when(w),
  };
}

/** Called with a command's result: toasts the message(a step-up refusal is handled centrally by the API client, so only a cancelled one reaches here). */
export function useOutcome(): <T extends object>(r: ApiResult<T>, okMsg?: string) => ApiResult<T> {
  const ui = useUI();
  return useCallback(
    (r, okMsg) => {
      if (r.ok) {
        ui.toast(okMsg ?? r.msg, "ok");
      } else {
        ui.toast(r.msg, "error");
      }
      return r;
    },
    [ui],
  );
}

export const versionOf = (x: unknown): number | undefined => {
  const v = (x as { version?: unknown } | null)?.version;
  return typeof v === "number" ? v : undefined;
};
/** The `If-Match` option for an entity read from the API (every versioned config entity carries `version`). */
export const ifMatchOf = (x: unknown): { ifMatch: number } | undefined => {
  const v = versionOf(x);
  return v === undefined ? undefined : { ifMatch: v };
};
/** After a successful save: the version the server returned, or the next one (every save bumps it by one). */
export const nextVersion = (result: unknown, current: number): number => {
  const v = (result as { version?: unknown } | null)?.version;
  return typeof v === "number" ? v : current + 1;
};
export const lockd = (reason: string, needs = "") => ({ allowed: false, reason, needs });

/** Prototype fmtDay: "13 Nov 2026" (UTC). */
export const fmtDay = (t: number | null | undefined): string => (t ? new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "\u2014");
