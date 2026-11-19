/** One plain sentence for a recorded event, built only from the event's own data (who, work order, station, gate, text). No event key is ever shown. */
import type { Catalog, EventEntry } from "@gantry/domain";

export interface EventTextCtx {
  cat: Catalog | null;
  /** Display name for an actor id (without the "(agent)" tag). */
  name: (id: string | null | undefined) => string;
}

const scopeWord = (s?: string) => (s === "factory" ? "the factory" : s === "workorder" ? "the work order" : s === "repo" ? "a repository" : "the project");

export function eventSentence(e: EventEntry, { cat, name }: EventTextCtx): string {
  const wo = e.wo ?? "";
  const who = e.by ? name(e.by) : "";
  const by = who ? `${who} ` : "";
  const st = e.station ? cat?.stations.find((s) => s.id === e.station) : undefined;
  const gate = e.gate ? (cat?.gates.find((g) => g.id === e.gate)?.label ?? e.gate) : "A gate";
  const reason = e.text ? `: ${e.text}` : "";
  const on = wo ? ` on ${wo}` : "";
  switch (e.type) {
    case "wo.submit": return `${by || "Someone "}submitted ${wo || "a work order"}${reason}`;
    case "wo.enter": return `${wo || "A work order"} moved to ${st ? `${st.no} ${st.name}` : (e.station ?? "the next station")}`;
    case "wo.bay": return `${wo || "A work order"} moved to ${cat?.bays.find((b) => b.id === e.bay)?.name ?? e.bay ?? "a bay"}${reason}`;
    case "wo.done": return `${wo || "A work order"} finished`;
    case "gate.decision":
      return e.mode === "auto" ? `${gate} passed on its checks${on}` : e.mode === "trust" ? `${gate} passed under trust${on}` : `${gate} decided${who ? ` by ${who}` : ""}${on}`;
    case "trust.auto": return `${gate} passed under trust${e.trust != null ? ` at L${e.trust}` : ""}${on}`;
    case "trust.change": return `Trust changed from L${e.from} to L${e.to}${reason}`;
    case "halt": return `${by || "Someone "}halted ${scopeWord(e.scope)}${reason}`;
    case "resume": return `${by || "Someone "}resumed ${scopeWord(e.scope)}`;
    case "kill": return `${by || "Someone "}killed ${scopeWord(e.scope)}${reason}`;
    case "restore": return `${by || "Someone "}restored ${scopeWord(e.scope)}${reason}`;
    case "release": return `Released${e.text ? ` ${e.text}` : ""}`;
    default: {
      // Unknown key: use the event's own text if it has one, else a generic sentence (never the key).
      if (e.text) return e.text;
      return `${by || "Something "}changed${on || ""}`.replace("Something changed", "An update was recorded");
    }
  }
}
