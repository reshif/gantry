/** Small pieces the record sections share (legacy record.js helpers). */
import { useState, type ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { Icon } from "../../ui/Icon";

export function Prov({ kind, text }: { kind: "system" | "agent" | "person" | "mixed"; text?: string }) {
  const map = { system: ["Observed by Gantry", "ledger"], agent: ["Reported by the agent", "agent"], person: ["Written by a person", "human"], mixed: ["Agents and people", "human"] } as const;
  const m = map[kind];
  return (
    <span className={`rec-prov rec-prov-${kind}`} title={text || m[0]}>
      <Icon name={m[1]} />
      <span>{text || m[0]}</span>
    </span>
  );
}
export const None = ({ text }: { text: string }) => <p className="rec-none muted small">{text}</p>;
export function Kv({ k, children }: { k: string; children?: ReactNode }) {
  return (
    <div className="rec-kv">
      <dt>{k}</dt>
      <dd>{children == null || children === "" ? "–" : children}</dd>
    </div>
  );
}

const open: Record<string, boolean> = {};
/** `<details>` that remembers its open state across renders. */
export function Fold({ k, summary, children, defOpen }: { k: string; summary: ReactNode; children: ReactNode; defOpen?: boolean }) {
  const [o, setO] = useState(open[k] ?? !!defOpen);
  return (
    <details
      className="rec-fold"
      open={o}
      onToggle={(e) => {
        const v = (e.currentTarget as HTMLDetailsElement).open;
        open[k] = v;
        setO(v);
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
export const when = (t: number | null | undefined): string => (t ? fmt.stamp(t) : "not yet");

import { useActors } from "../../ui/actors";
/** Name of an actor without the " (agent)" suffix. */
export function useName(): (id: string | null | undefined) => string {
  const a = useActors();
  return (id) => (id ? a(id).name.replace(" (agent)", "") : "someone");
}
export function useIsAgent(): (id: string | null | undefined) => boolean {
  const a = useActors();
  return (id) => !!id && (a(id).kind === "agent" || id.startsWith("ag-"));
}
