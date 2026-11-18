/**
 * Who holds what right now, from real reads: open work orders a person requested (per project, among the projects the viewer can see)
 * and the waiting gates they are eligible to approve (the workload snapshot). Shared by the Person page and the Workload matrix.
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Project, WorkOrder } from "@gantry/domain";
import { api, get } from "../../api/client";
import { qk } from "../../api/keys";
import { useWorkload } from "../../api/queries";
import type { Page } from "../../api/types";

const isOpen = (w: WorkOrder): boolean => w.state !== "done" && w.state !== "killed";

export interface PeopleLoad {
  /** Open work orders requested by `person` in `project`. */
  requested: (person: string, project: string) => number;
  /** Waiting gates `person` is eligible to approve in `project` (null project: all). */
  eligible: (person: string, project?: string) => number;
  loading: boolean;
  /** Some read failed or was refused: the figures are partial and must not be read as zero. */
  partial: boolean;
}

export function usePeopleLoad(projects: Project[]): PeopleLoad {
  const lists = useQueries({
    queries: projects.map((pr) => ({
      queryKey: qk.workOrders(pr.id, { govern: "open" }),
      queryFn: async () => {
        const r = await get<WorkOrder[] | Page<WorkOrder>>(api(`projects/${encodeURIComponent(pr.id)}/work-orders`), {});
        return Array.isArray(r) ? r : r.items;
      },
    })),
  });
  const wl = useWorkload("all", 7);
  const sig = lists.map((l) => l.dataUpdatedAt).join(",");
  const wlData = wl.data;
  return useMemo(() => {
    const req = new Map<string, number>();
    projects.forEach((pr, i) => {
      for (const w of lists[i]?.data ?? []) if (isOpen(w)) req.set(`${w.requestedBy}|${pr.id}`, (req.get(`${w.requestedBy}|${pr.id}`) ?? 0) + 1);
    });
    const elig = new Map<string, number>();
    for (const row of wlData?.rows ?? []) for (const g of row.waitingGates) elig.set(`${row.person}|${g.wo.project}`, (elig.get(`${row.person}|${g.wo.project}`) ?? 0) + 1);
    return {
      requested: (person, project) => req.get(`${person}|${project}`) ?? 0,
      eligible: (person, project) => (project ? elig.get(`${person}|${project}`) ?? 0 : (wlData?.rows.find((r) => r.person === person)?.waitingGates.length ?? 0)),
      loading: lists.some((l) => l.isPending) || wl.isPending,
      partial: lists.some((l) => l.isError) || wl.isError,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, sig, wlData, wl.isPending, wl.isError]);
}
