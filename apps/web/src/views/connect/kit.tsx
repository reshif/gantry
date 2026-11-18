/**
 * Shared pieces of the Connect group (Integrations, Notifications, MCP servers, API & triggers), after the Blueprint prototype's
 * `dataView`: one filter bar per list (Search, labelled selects, count, Clear), sortable columns with the sort in the URL, 12 rows a page
 * with "a-b of N" and Prev / Next, and the shared empty states. Tabs live in the URL (`?tab=`).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Btn, Empty, Field, FilterBar, SearchBox, Select, Toggle, type Decision } from "../../ui/primitives";
import { DataTable, type Col, type SortState } from "../../ui/DataTable";
import { useQueryParam } from "../floor/urlState";

export const PAGE = 12;

/** Coarse relative time as in the prototype: "5m ago", "11h ago", "2d ago", "in 3h". */
export function ago(t: number | null | undefined, now: number = Date.now()): string {
  if (!t) return "—";
  let d = (now - t) / 1000;
  const fut = d < 0;
  d = Math.abs(d);
  const u: [number, string] = d < 3600 ? [Math.max(1, Math.round(d / 60)), "m"] : d < 86400 ? [Math.round(d / 3600), "h"] : [Math.round(d / 86400), "d"];
  return fut ? `in ${u[0]}${u[1]}` : `${u[0]}${u[1]} ago`;
}

export const plural = (n: number, s: string): string => `${n} ${n === 1 ? s : `${s}s`}`;

export const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** The active tab, held in the URL (`?tab=`); an unknown or missing value is the first tab. */
export function useTab(ids: readonly string[], fallback?: string): [string, (id: string) => void] {
  const [raw, set] = useQueryParam("tab");
  const tab = raw && ids.includes(raw) ? raw : fallback ?? ids[0]!;
  return [tab, set];
}

/** A label with an optional hint on the left and a switch on the right (prototype toggleRow). */
export function SwitchRow({ id, label, hint, checked, onChange, decision, extra }: { id: string; label: string; hint?: ReactNode; checked: boolean; onChange?: (v: boolean) => void; decision?: Decision | null; extra?: ReactNode }) {
  return (
    <div className="check switch-row" style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
      <label htmlFor={id}>{label}{hint ? <span className="sub muted small" style={{ display: "block" }}>{hint}</span> : null}</label>
      <span className="row">{extra}<Toggle id={id} checked={checked} label={label} decision={decision} {...(onChange ? { onChange } : {})} /></span>
    </div>
  );
}

/** A chip tone for a health or outcome word, as the prototype's healthTone. */
export const healthTone = (s: string | null | undefined): string => (s === "healthy" || s === "ok" ? "ok" : s === "degraded" || s === "warning" || s === "pending" || s === "allowed" ? "warn" : s ? (s === "disabled" ? "plain" : "bad") : "plain");

export interface ListFilter<R> {
  key: string;
  label: string;
  options: Array<string | [string, string]>;
  /** Defaults to String(row[key]) === value. */
  test?: (r: R, value: string) => boolean;
}

/**
 * One list: FilterBar + sortable, paged DataTable. `columns` use DataTable's Col; sorting by a column key is held in `?sort=<id>.<key>.<dir>`.
 * Rows are filtered, sorted, then cut to the page.
 */
export function ListView<R>({ id, noun, rows, text, filters = [], columns, rowKey, rowId, onRow, rowLabel, empty, defaultSort, search = true, children }: {
  id: string;
  noun: string;
  rows: R[];
  text: (r: R) => string;
  filters?: ListFilter<R>[];
  columns: Col<R>[];
  rowKey: (r: R) => string;
  rowId?: (r: R) => string;
  onRow?: (r: R) => void;
  rowLabel?: (r: R) => string;
  empty?: ReactNode;
  defaultSort?: SortState;
  search?: boolean;
  children?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [rawSort, setRawSort] = useQueryParam("sort");
  const sort: SortState | undefined = useMemo(() => {
    const m = rawSort?.match(/^([^.]+)\.(.+)\.(-?1)$/);
    if (m && m[1] === id && columns.some((c) => c.key === m[2] && c.sort)) return { key: m[2]!, dir: Number(m[3]) as 1 | -1 };
    return defaultSort;
  }, [rawSort, id, columns, defaultSort]);
  const needle = q.trim().toLowerCase();
  let list = rows.filter((r) => (!needle || text(r).toLowerCase().includes(needle)) && filters.every((fl) => !f[fl.key] || (fl.test ? fl.test(r, f[fl.key]!) : String((r as Record<string, unknown>)[fl.key]) === f[fl.key])));
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (sort && col) {
    const val = (r: R): number | string => (typeof col.sort === "function" ? col.sort(r) : ((r as Record<string, unknown>)[col.key] as number | string));
    list = list.slice().sort((a, b) => { const x = val(a); const y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  }
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const at = Math.min(page, pages - 1);
  const vis = list.slice(at * PAGE, (at + 1) * PAGE);
  const active = !!needle || Object.values(f).some(Boolean);
  const clear = (): void => { setQ(""); setF({}); setPage(0); };
  return (
    <div id={id}>
      <FilterBar label={`Filter ${noun}s`} count={`${plural(total, noun)}${total !== rows.length ? ` of ${rows.length}` : ""}`} actions={active ? <Btn label="Clear" small kind="ghost" id={`${id}-clear`} onClick={clear} /> : undefined}>
        {search ? <SearchBox id={`${id}-q`} label={`Search ${noun}s`} placeholder="Search…" value={q} onChange={(v) => { setQ(v); setPage(0); }} /> : null}
        {filters.map((fl) => (
          <Field key={fl.key} label={fl.label} htmlFor={`${id}-f-${fl.key}`}>
            <Select id={`${id}-f-${fl.key}`} aria-label={fl.label} value={f[fl.key] ?? ""} onChange={(v) => { setF({ ...f, [fl.key]: v }); setPage(0); }} options={[{ value: "", label: "All" }, ...fl.options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o }))]} />
          </Field>
        ))}
      </FilterBar>
      {children}
      {!rows.length ? (empty ?? <Empty title="Nothing here yet" text="Items will appear here when they exist." />) : !total ? (
        <Empty title="Nothing matches these filters" text="Loosen the search or clear the filters." action={<Btn label="Clear filters" id={`${id}-clear-empty`} onClick={clear} />} />
      ) : (
        <>
          <DataTable id={`${id}-table`} caption={`${noun}s`} columns={columns} rows={vis} rowKey={rowKey} {...(rowId ? { rowId } : {})} {...(onRow ? { onRow } : {})} {...(rowLabel ? { rowLabel } : {})} sort={sort} onSort={(s) => setRawSort(`${id}.${s.key}.${s.dir}`)} />
          <div className="tfoot">
            <span role="status">{`${at * PAGE + 1}–${at * PAGE + vis.length} of ${total}`}</span>
            {pages > 1 ? (
              <div className="row">
                <Btn label="Prev" small id={`${id}-prev`} guard={at === 0 ? { allowed: false, reason: "First page" } : null} onClick={() => setPage(at - 1)} />
                <span>{`Page ${at + 1} / ${pages}`}</span>
                <Btn label="Next" small id={`${id}-next`} guard={at >= pages - 1 ? { allowed: false, reason: "Last page" } : null} onClick={() => setPage(at + 1)} />
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
