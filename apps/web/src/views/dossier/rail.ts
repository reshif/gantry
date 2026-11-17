/** The work order's route as pipeline steps, read from what the API says about it: where it is, its history and its gates. Presentation only. */
import { fmt, flowOf, gateAfter, type Catalog, type Project } from "@gantry/domain";
import type { GateState, PipelineStep, StepState } from "../../ui/pipeline";
import type { TWo } from "../traveler/model";

/** How long a station held the work order, short ("23s", "3m"); empty before it started. */
export function spent(wo: Pick<TWo, "history">, station: string): string {
  const ms = wo.history.filter((h) => h.station === station).reduce((t, h) => t + Math.max(0, (h.endedAt ?? h.startedAt) - h.startedAt), 0);
  return ms > 0 ? fmt.dur(ms) : "";
}

export function railOf(wo: TWo, cat: Catalog, project: Project): PipelineStep[] {
  const fl = flowOf(cat, project);
  const cur = wo.station;
  const stations = fl.stations.filter((s) => wo.route.includes(s.id) || wo.history.some((h) => h.station === s.id));
  return stations.map((st) => {
    const idx = cat.stations.findIndex((s) => s.id === st.id);
    const visited = wo.history.some((h) => h.station === st.id);
    const g = gateAfter(cat, st.id);
    const gi = g ? wo.gates[g.id] : undefined;
    let state: StepState = "waiting";
    if (wo.state === "done") state = visited || wo.route.includes(st.id) ? "passed" : "skip";
    else if (idx < cur) state = visited ? "passed" : "skip";
    else if (idx === cur) state = wo.state === "running" ? "running" : wo.state === "failed" || wo.state === "killed" ? "failed" : wo.state === "blocked" || wo.bay ? "warn" : gi?.status === "waiting" ? "passed" : "waiting";
    else if (!wo.route.includes(st.id)) state = "skip";
    const t = spent(wo, st.id);
    let gate: PipelineStep["gate"];
    if (g && wo.route.includes(st.id)) {
      const gs: GateState = !gi ? "todo" : gi.status === "waiting" ? "wait" : gi.status === "passed" ? "passed" : "todo";
      gate = { state: gs, label: `${g.label} ${g.name}` };
    }
    const step: PipelineStep = { key: st.id, name: t ? `${st.name} · ${t}` : st.name, state };
    if (gate) step.gate = gate;
    return step;
  });
}
