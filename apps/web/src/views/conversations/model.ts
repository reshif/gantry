/** Conversation status of a work order (legacy conversations.js helpers). */
import type { Catalog, WorkOrder } from "@gantry/domain";
import { stName } from "../traveler/model";

export const FU_MAX = 3;
export const atIntake = (wo: WorkOrder): boolean => wo.station === 0 && !wo.bay && wo.state !== "killed" && !!wo.gates.G0G1 && wo.gates.G0G1.status !== "passed";
export const raisedOpen = (wo: WorkOrder) => (wo.conv.raised || []).filter((q) => !q.answered);
export const isOpen = (wo: WorkOrder): boolean => wo.state !== "killed" && wo.bay !== "declined" && (atIntake(wo) || raisedOpen(wo).length > 0 || (wo.bay === "person" && wo.bayFrom === "intake"));
export const lastAt = (wo: WorkOrder): number => {
  const m = wo.conv.messages;
  return m.length ? m[m.length - 1]!.at : wo.createdAt;
};
export interface ConvStatus {
  id: "killed" | "declined" | "raised" | "ready" | "asking" | "confirmed";
  text: string;
  glyph: string;
}
export function convStatus(wo: WorkOrder, cat: Catalog | null): ConvStatus {
  if (wo.state === "killed") return { id: "killed", text: "Killed", glyph: "st-kill" };
  if (wo.bay === "declined") return { id: "declined", text: "Declined", glyph: "x" };
  const r = raisedOpen(wo);
  if (r.length) return { id: "raised", text: `Question from ${stName(cat, r[0]!.station)}`, glyph: "human" };
  if (wo.bay === "person" && wo.bayFrom === "intake") return { id: "raised", text: "Needs a person at Intake", glyph: "human" };
  if (atIntake(wo)) return wo.conv.done ? { id: "ready", text: "Brief ready to confirm", glyph: "gate" } : { id: "asking", text: `Question ${Math.min(wo.conv.qi + 1, wo.conv.questions.length)} of ${wo.conv.questions.length}`, glyph: "chat" };
  return { id: "confirmed", text: "Brief confirmed", glyph: "check" };
}
