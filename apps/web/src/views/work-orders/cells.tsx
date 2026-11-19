/** Cells shared by the work orders table and board, in the prototype's wording: the state chip ("At G2", "Parked · bay"), priority chip, short age. */
import { gateLabelOf } from "../../lib/gate-label";
import { bayDef, gateForWO, type Catalog, type Project, type WorkOrder } from "@gantry/domain";
import { Chip } from "../../ui/primitives";

/** "13h ago": one unit, as the prototype's `ago`. */
export function agoShort(t: number, now: number = Date.now()): string {
  if (!t) return "—";
  let d = (now - t) / 1000;
  const fut = d < 0;
  d = Math.abs(d);
  const u: [number, string] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "m"] : d < 86400 ? [Math.round(d / 3600), "h"] : [Math.round(d / 86400), "d"];
  return fut ? `in ${u[0]}${u[1]}` : `${u[0]}${u[1]} ago`;
}

const TONE: Record<string, string> = { running: "info", waiting: "warn", parked: "plain", blocked: "bad", failed: "bad", done: "ok", killed: "bad" };

export function WoStateChip({ w, cat, project }: { w: WorkOrder; cat: Catalog; project: Project | null }) {
  if (w.state === "waiting" && !w.bay) {
    const g = gateForWO(cat, project, w);
    if (g) return <Chip text={`At ${gateLabelOf(g.label, g.id)}`} cls="warn" />;
  }
  if (w.state === "parked" || w.bay) return <Chip text={`Parked · ${w.bay ? (bayDef(cat, w.bay)?.name ?? w.bay) : "bay"}`} cls="plain" />;
  return <Chip text={w.state} cls={TONE[w.state] ?? "plain"} />;
}

export const PrioChip = ({ p }: { p: string }) => <Chip text={p} cls={p === "P0" || p === "P1" ? "bad" : p === "P2" ? "info" : "plain"} />;
