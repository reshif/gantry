/** Repos per project for the portfolio table: one read per project (the API lists repos per project, there is no portfolio-wide read). `null` while loading or when the read failed. */
import { useQueries } from "@tanstack/react-query";
import type { Repo } from "@gantry/domain";
import { api, get } from "../../api/client";
import { qk } from "../../api/keys";

export function useRepoCounts(projectIds: string[]): Record<string, number | null> {
  const results = useQueries({
    queries: projectIds.map((id) => ({ queryKey: qk.repos(id), queryFn: () => get<Repo[]>(api(`projects/${encodeURIComponent(id)}/repos`)) })),
  });
  const out: Record<string, number | null> = {};
  projectIds.forEach((id, i) => { out[id] = results[i]?.data ? results[i]!.data!.length : null; });
  return out;
}
