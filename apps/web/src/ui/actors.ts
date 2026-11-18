/** Name and initials for an actor id: a person, an agent or the system. API keys and triggers show their id (their lists need extra permissions). */
import { useAgents, useMe, usePeople } from "../api/queries";

export interface Actor {
  id: string;
  name: string;
  initials: string;
  kind: "person" | "agent" | "other";
}

const initialsOf = (name: string): string =>
  name
    .split(" ")
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2);

export function useActors(): (id: string | null | undefined) => Actor {
  const self = useMe()?.person;
  const people = usePeople().data;
  const agents = useAgents().data;
  return (id) => {
    const key = id ?? "";
    const p = self?.id === key ? self : people?.find((x) => x.id === key);
    if (p) return { id: key, name: p.name, initials: initialsOf(p.name), kind: "person" };
    const a = agents?.find((x) => x.id === key);
    if (a) return { id: key, name: `${a.name} (agent)`, initials: a.initials, kind: "agent" };
    if (key === "system") return { id: key, name: "Gantry", initials: "?", kind: "other" };
    // A person the viewer may not list (the people list is permission-gated): show a readable name, never the raw id.
    const bare = /^p-([a-z][a-z0-9]*)$/i.exec(key)?.[1];
    if (bare) { const name = bare[0]!.toUpperCase() + bare.slice(1); return { id: key, name, initials: initialsOf(name), kind: "person" }; }
    return { id: key, name: key || "system", initials: "?", kind: "other" };
  };
}
