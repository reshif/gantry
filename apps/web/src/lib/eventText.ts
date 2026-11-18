/** One line for an activity event, for the Home feed and the Floor ticker. Same wording as the Floor replay log. */
import type { Catalog, EventEntry } from "@gantry/domain";

export type EventTone = "ok" | "warn" | "bad" | "info" | "agent" | "idle";

export function eventText(e: EventEntry, cat: Catalog | null, nameOf: (id: string | null | undefined) => string): string {
  const gd = e.gate ? cat?.gates.find((g) => g.id === e.gate) : undefined;
  const st = e.station ? cat?.stations.find((s) => s.id === e.station) : undefined;
  const who = e.by ? nameOf(e.by) : "a person";
  const wo = e.wo ? `${e.wo} ` : "";
  switch (e.type) {
    case "gate.decision": return `${wo}${gd ? gd.label : (e.gate ?? "a gate")} decided by ${who}`;
    case "trust.auto": return `${wo}${gd ? gd.label : (e.gate ?? "a gate")} passed under trust at L${e.trust}`;
    case "halt": return `${e.scope === "repo" ? "Repo" : "Project"} halted by ${who}`;
    case "resume": return `${e.scope === "repo" ? "Repo" : "Project"} resumed by ${who}`;
    case "kill": return `${e.scope === "factory" ? "Factory" : "Project"} killed by ${who}`;
    case "restore": return `${e.scope === "factory" ? "Factory" : "Project"} restored by ${who}`;
    case "release": return `Released ${e.text ?? wo.trim()}`;
    case "wo.submit": return `${wo}submitted${e.text ? `: ${e.text}` : ""}`;
    case "wo.enter": return `${wo}entered ${st ? st.name : (e.station ?? "a station")}`;
    case "wo.bay": return `${wo}moved to ${cat?.bays.find((b) => b.id === e.bay)?.name ?? e.bay ?? "a bay"}`;
    case "trust.change": return `Trust L${e.from} to L${e.to}`;
    default: return `${wo}${e.text ?? e.type}`;
  }
}

export function eventTone(e: EventEntry): EventTone {
  if (e.type === "kill" || e.type === "halt") return "bad";
  if (e.type === "gate.decision" || e.type === "wo.bay") return "warn";
  if (e.type === "release") return "ok";
  if (e.type === "wo.enter") return "info";
  return "idle";
}

/** The rows of an activity read, which is a list or a page of items. */
export function eventRows(d: unknown): EventEntry[] {
  const raw = Array.isArray(d) ? d : ((d as { items?: unknown[] } | undefined)?.items ?? []);
  return raw.map((r) => toEvent(r as Record<string, unknown>));
}

/**
 * The live /activity read returns audit rows (`action`, `target`, `actor`), not the prototype's event shape (`type`, `text`, `by`).
 * Map them so a row never prints "undefined": the action is the type, the target the text, the actor the person.
 */
export function toEvent(r: Record<string, unknown>): EventEntry {
  if (typeof r.type === "string") return { ...r, id: Number(r.id ?? 0), at: Number(r.at ?? 0), type: r.type } as EventEntry;
  const action = typeof r.action === "string" ? r.action : "event";
  const target = typeof r.target === "string" && r.target ? r.target : undefined;
  const ent = r.entity as { type?: unknown; id?: unknown } | null | undefined;
  const wo = ent && ent.type === "wo" && typeof ent.id === "string" ? ent.id : target && /^WO-\d+$/i.test(target) ? target : typeof r.wo_id === "string" ? r.wo_id : undefined;
  return {
    id: Number(r.id ?? r.seq ?? 0), at: Number(r.at ?? 0), type: action,
    ...(typeof r.project === "string" ? { project: r.project } : {}),
    ...(wo ? { wo } : {}),
    ...(typeof r.actor === "string" ? { by: r.actor } : {}),
    ...(target && !wo && !(ent && ent.type === "wo") ? { text: target } : {}),
  };
}

/** Station entries per hour over the last 24 hours (oldest first), from the activity feed. */
export function hourly(events: Array<{ at: number; type: string }>): number[] {
  const now = Date.now();
  const out = Array.from({ length: 24 }, () => 0);
  for (const e of events) {
    if (e.type !== "wo.enter") continue;
    const age = Math.floor((now - e.at) / 3_600_000);
    if (age >= 0 && age < 24) out[23 - age] = (out[23 - age] ?? 0) + 1;
  }
  return out;
}
