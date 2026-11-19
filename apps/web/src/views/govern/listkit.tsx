/**
 * The Blueprint list toolbar shared by the Security and Audit lists: search + selects on one row, a count ("12 entries" or
 * "3 of 12 entries") and a ghost Clear while anything is filtered. The state lives in the URL (rule F-15) through useQueryParam.
 */
import type { ReactNode } from "react";
import { Btn, Field, FilterBar, SearchBox, Select, type Option } from "../../ui/primitives";

export interface BarFilter {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<string | Option>;
}

export const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;

export function ListBar({ id, label, q, onQ, filters, shown, total, noun, onClear, extra }: { id: string; label: string; q: string; onQ: (v: string) => void; filters: BarFilter[]; shown: number; total: number; noun: string; onClear: () => void; extra?: ReactNode }): ReactNode {
  const dirty = !!q || filters.some((f) => f.value !== "all");
  return (
    <FilterBar label={label} count={`${shown === total ? plural(total, noun) : `${shown} of ${plural(total, noun)}`}`} actions={dirty || extra ? <>{dirty ? <Btn label="Clear" small kind="ghost" id={`${id}-clear`} onClick={onClear} /> : null}{extra}</> : undefined}>
      <SearchBox id={`${id}-q`} value={q} onChange={onQ} placeholder="Search…" label={`Search ${noun}s`} />
      {filters.map((f) => (
        <Field key={f.id} label={f.label} htmlFor={`${id}-f-${f.id}`}>
          <Select id={`${id}-f-${f.id}`} options={f.options} value={f.value} onChange={f.onChange} />
        </Field>
      ))}
    </FilterBar>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Nov 13:34" in UTC, the prototype's fmtDate. A time that is not a number reads as a dash, never an exception. */
export function dayMon(t: number): string {
  if (!Number.isFinite(t)) return "\u2014";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The prototype's relative time: one unit, "5m ago", "13h ago", "3d ago". */
export function agoShort(t: number | null | undefined, now: number): string {
  if (!t) return "\u2014";
  let d = (now - t) / 1000;
  const future = d < 0;
  d = Math.abs(d);
  const [n, u] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "m"] : d < 86400 ? [Math.round(d / 3600), "h"] : [Math.round(d / 86400), "d"];
  return future ? `in ${n}${u}` : `${n}${u} ago`;
}
