/** One line for an activity event, for the Home feed and the Floor ticker. Same wording as the Floor replay log. */
import type { Catalog, EventEntry } from "@gantry/domain";

export type EventTone = "ok" | "warn" | "bad" | "info" | "agent" | "idle";

export function eventText(e: EventEntry, cat: Catalog | null, nameOf: (id: string | null | undefined) => string): string {
  const gd = e.gate ? cat?.gates.find((g) => g.id === e.gate) : undefined;
  const st = e.station ? cat?.stations.find((s) => s.id === e.station) : undefined;
  const who = e.by ? nameOf(e.by) : "a person";
  const wo = e.wo ? `${e.wo} ` : "";
  switch (e.type) {
    case "gate.decision": return `${wo}${gd ? gd.label : e.gate} decided by ${who}`;
    case "trust.auto": return `${wo}${gd ? gd.label : e.gate} passed under trust at L${e.trust}`;
    case "halt": return `${e.scope === "repo" ? "Repo" : "Project"} halted by ${who}`;
    case "resume": return `${e.scope === "repo" ? "Repo" : "Project"} resumed by ${who}`;
    case "kill": return `${e.scope === "factory" ? "Factory" : "Project"} killed by ${who}`;
    case "restore": return `${e.scope === "factory" ? "Factory" : "Project"} restored by ${who}`;
    case "release": return `Released ${e.text ?? wo.trim()}`;
    case "wo.submit": return `${wo}submitted${e.text ? `: ${e.text}` : ""}`;
    case "wo.enter": return `${wo}entered ${st ? st.name : (e.station ?? "a station")}`;
    case "wo.bay": return `${wo}moved to ${cat?.bays.find((b) => b.id === e.bay)?.name ?? e.bay}`;
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
export function eventRows(d: EventEntry[] | { items: EventEntry[] } | undefined): EventEntry[] {
  return Array.isArray(d) ? d : (d?.items ?? []);
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
