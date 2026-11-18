/** Small Blueprint building blocks shared by Onboarding and Project config: key/value list, switch row, URL-held tab. */
import { Children, Fragment, type ReactNode } from "react";
import { Toggle, type Decision } from "../../ui/primitives";
import { useQueryParam } from "./urlState";

/** Prototype `kv`: a definition list of label / value rows. */
export function Kv({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="kv">
      {rows.filter((r): r is [ReactNode, ReactNode] => !!r).map(([k, v], i) => (
        <Fragment key={i}><dt>{k}</dt><dd>{v ?? "—"}</dd></Fragment>
      ))}
    </dl>
  );
}

/** Prototype `toggleRow`: a label with an optional hint under it and a switch on the right. */
export function ToggleRow({ id, label, hint, checked, onChange, decision }: { id: string; label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; decision?: Decision | null }) {
  return (
    <div className="check" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
      <span>{label}{hint ? <span className="sub muted small" style={{ display: "block" }}>{hint}</span> : null}</span>
      <Toggle id={id} checked={checked} decision={decision} label={typeof label === "string" ? label : id} onChange={onChange} />
    </div>
  );
}

/** The active tab, held in the URL as `?tab=`; an unknown or absent value is the default. */
export function useTab(ids: string[], def: string): [string, (id: string) => void] {
  const [q, setQ] = useQueryParam("tab");
  const active = q && ids.includes(q) ? q : def;
  return [active, (id) => setQ(id === def ? null : id)];
}

export const countChildren = (c: ReactNode): number => Children.toArray(c).filter(Boolean).length;
