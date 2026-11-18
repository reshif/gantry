/** What waits on the viewer: the gate they may decide, and the proposals and questions in the conversation that are theirs. */
import type { Catalog } from "@gantry/domain";
import type { TWo } from "../traveler/model";
import type { WoSession } from "../conversations/session-api";

export function waitingOnYou(wo: TWo, cat: Catalog, s: WoSession | undefined): Array<{ key: string; text: string; go: "decide" | "activity"; target?: string }> {
  const out: Array<{ key: string; text: string; go: "decide" | "activity"; target?: string }> = [];
  const ap = wo.allowed.approve;
  const g = ap && ap.allowed ? cat.gates.find((x) => x.id === ap.gate) : undefined;
  if (g && !wo.bay && wo.state === "waiting") out.push({ key: `gate-${g.id}`, text: g.id === "G0G1" ? "Confirm the brief" : `Decide ${g.label} ${g.name}`, go: "decide" });
  for (const p of s?.pending ?? []) out.push({ key: `p-${p.id}`, text: p.title, go: "activity", target: `wos-prop-${p.id}` });
  for (const q of s?.dialogue.questions ?? []) if (q.status === "open" && q.mine) out.push({ key: `q-${q.id}`, text: q.question, go: "activity", target: `sq-${q.id.replace(/[^A-Za-z0-9_-]/g, "-")}` });
  return out;
}
