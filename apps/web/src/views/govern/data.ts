/**
 * Shared data and helpers for the People, Access and Security screens: the teams read, every repo the viewer can see
 * (one call per visible project), a policy-state shim so the domain's policy wording works on API data, and the
 * result handler that turns a refused command into a toast (and a step-up redirect when the server asks for one).
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { policyText, type Catalog, type Policy, type PolicyState, type Repo, type Team } from "@gantry/domain";
import { api, get, type ApiResult } from "../../api/client";
import { useAccessMatrix, useMe, usePeople, usePolicies } from "../../api/queries";
import { qk } from "../../api/keys";
import { stepUpUrl } from "../../api/ops";
import { useUI } from "../../ui/overlay-context";

export const useTeams = () => useQuery({ queryKey: ["teams"] as const, queryFn: () => get<Team[]>(api("teams")) });

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

/** Called with a command's result: toasts the message, and sends the person to a fresh sign-in when the server asks for one (spec 14.1). */
export function useOutcome(): <T extends object>(r: ApiResult<T>, okMsg?: string) => ApiResult<T> {
  const ui = useUI();
  return useCallback(
    (r, okMsg) => {
      if (r.ok) {
        ui.toast(okMsg ?? r.msg, "ok");
      } else if (r.needs === "step_up") {
        ui.toast("Sign in again to confirm this change.", "warn");
        setTimeout(() => window.location.assign(stepUpUrl()), 700);
      } else {
        ui.toast(r.msg, "error");
      }
      return r;
    },
    [ui],
  );
}

export const isAdminLike = (roles: ReadonlyArray<{ role: string; scope: string }>): boolean => roles.some((g) => g.role === "factory_admin");
export const versionOf = (x: unknown): number | undefined => {
  const v = (x as { version?: unknown } | null)?.version;
  return typeof v === "number" ? v : undefined;
};
export const lockd = (reason: string, needs = "") => ({ allowed: false, reason, needs });
