/** An agent's avatar, or the first letter of the station/name when the directory does not know the id: never a "?". */
import { Avatar } from "../../ui/primitives";
import { useActors } from "../../ui/actors";

export function StationAvatar({ id, fallback }: { id: string | null | undefined; fallback: string }) {
  const actor = useActors()(id);
  if (actor.kind !== "other") return <Avatar id={id} />;
  return <span className="av av-agent" title={fallback} aria-hidden="true">{fallback.trim().charAt(0).toUpperCase() || "G"}</span>;
}
