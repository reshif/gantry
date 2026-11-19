/**
 * The Console's instant answers from live state (prototype "Answers are read from live work-order state"): what is blocked, what waits on a person,
 * the status of one work order, spend. They are worked out from the typed reads the page already holds (work orders, the approvals the home read lists,
 * the projects' metered spend); nothing is invented and no model is called. A question this does not recognise returns null and goes to the model
 * (or, with no model, to the help line below).
 */
import { fmt } from "@gantry/domain";

export interface LiveWo { id: string; title: string; state: string; station?: number; stationName?: string; priority?: string; progress?: number; blockReason?: string | null; failReason?: string | null; project?: string }
export interface LiveCtx {
  wos: LiveWo[];
  /** The work orders waiting on a person, with the gate each one waits at. */
  waiting: Array<{ wo: string; gate?: string }>;
  spend: { mtd: number; monthly: number } | null;
  /** The project name the work orders belong to. */
  project?: string | null;
}

export const isInFlight = (w: LiveWo): boolean => w.state !== "done" && w.state !== "killed";

/** What can be asked, with the live number of work orders in flight (shown when a question is not recognised and no model is configured). */
export function helpText(ctx: LiveCtx): string {
  return `I can answer questions about work orders (try "status of WO-2417"), what waits on people, what is blocked, and spend. The line has ${ctx.wos.filter(isInFlight).length} work orders in flight.`;
}

/** Null when the text is not one of the live questions. */
export function liveAnswer(text: string, ctx: LiveCtx): string | null {
  const q = text.toLowerCase();
  const m = text.match(/WO-\d+/i);
  if (m) {
    const id = m[0].toUpperCase();
    const w = ctx.wos.find((x) => x.id === id);
    if (!w) return `I cannot find ${id}.`;
    const gate = ctx.waiting.find((x) => x.wo === w.id)?.gate;
    return `${w.id} "${w.title}" is ${w.state}${w.stationName ? ` at ${w.stationName}` : ""}${ctx.project ? ` (${ctx.project})` : ""}.${w.priority ? ` Priority ${w.priority}${typeof w.progress === "number" ? `, ${Math.round(w.progress)}% through the current station` : ""}.` : typeof w.progress === "number" ? ` ${Math.round(w.progress)}% through the current station.` : ""}${gate ? ` It waits on gate ${gate}.` : ""}${w.blockReason ? ` Blocked: ${w.blockReason}` : ""}`;
  }
  if (/wait|approv|inbox/.test(q)) {
    const p = ctx.waiting;
    return p.length ? `${p.length} work orders wait on a person: ${p.slice(0, 5).map((x) => (x.gate ? `${x.wo} (${x.gate})` : x.wo)).join(", ")}.` : "Nothing is waiting on a person.";
  }
  if (/block|stuck|fail/.test(q)) {
    const s = ctx.wos.filter((w) => w.state === "blocked" || w.state === "failed");
    return s.length ? s.map((w) => `${w.id}: ${w.blockReason || w.failReason || w.state}`).join(" ") : "No work orders are blocked or failed.";
  }
  if (/cost|spend|budget/.test(q)) return ctx.spend ? `Spend this month is ${fmt.money(ctx.spend.mtd)} of ${fmt.money(ctx.spend.monthly)}.` : "Spend is not available to you.";
  return null;
}
