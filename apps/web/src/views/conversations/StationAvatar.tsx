/** An agent's avatar, or the first letter of the station/name when the directory does not know the id: never a "?". */
import { Avatar } from "../../ui/primitives";
import { useActors } from "../../ui/actors";

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** The name to show for an actor id: the directory's name, else the station an `ag-<station>` id stands for, never the raw id. */
export function useAgentLabel(): (id: string | null | undefined, fallback?: string) => string {
  const actor = useActors();
  return (id, fallback) => {
    const a = actor(id);
    if (a.kind !== "other") return a.name.replace(" (agent)", "");
    if (id === "system") return "Gantry";
    if (id && id.startsWith("ag-")) return cap(id.slice(3).replace(/[-_]+/g, " "));
    return fallback ?? id ?? "Gantry";
  };
}

export function StationAvatar({ id, fallback }: { id: string | null | undefined; fallback: string }) {
  const actor = useActors()(id);
  if (actor.kind !== "other") return <Avatar id={id} />;
  return <span className="av av-agent" title={fallback} aria-hidden="true">{fallback.trim().charAt(0).toUpperCase() || "G"}</span>;
}
