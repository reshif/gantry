/**
 * DataTable: the one table. Sortable headers (buttons), optional row action, paging, and a card layout under 640px
 * (same DOM, laid out by CSS: no second copy of the rows).
 *
 * Clickable rows (panel decision A11Y-10): the row is NOT focusable. When `onRow` (or `rowHref`) is given, the first cell gets a real
 * button (or link) whose accessible name is the cell's own text; a click anywhere else on the row is a mouse convenience that ignores
 * nested controls. If the first cell already holds its own link or button, no extra control is added.
 *
 * Wide tables scroll inside a focusable, labelled region (keyboard users can scroll it) with edge shadows; the page itself never scrolls sideways.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Empty } from "./primitives";

export interface Col<R> {
  key: string;
  label: string;
  /** true sorts by `row[key]`; a function gives the value to sort by. */
  sort?: boolean | ((r: R) => number | string);
  align?: "end";
  hideSmall?: boolean;
  width?: string;
  render?: (r: R) => ReactNode;
}
export type SortCol<R> = Col<R>;
export interface SortState {
  key: string;
  dir: 1 | -1;
}

const INTERACTIVE = "a[href],button,input,select,textarea,[role=button],[role=link]";

export function DataTable<R>({ id, caption, columns, rows, rowKey, rowId, onRow, rowHref, rowLabel, sort, onSort, pageSize, pager, empty, hasMore, onLoadMore, loadingMore, total }: {
  id?: string;
  /** Names the table for screen readers and the scroll region. */
  caption?: string;
  columns: Col<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  /** Optional DOM id for each row. */
  rowId?: (r: R) => string;
  /** Opens the row. Keyboard and screen-reader users reach it through the first cell's button. */
  onRow?: (r: R) => void;
  /** Like onRow but a real link (middle-click, copy address). Wins over onRow for the first cell. */
  rowHref?: (r: R) => string;
  /** Accessible name of the first-cell control when the cell's text is not enough ("Open work order WO-12"). */
  rowLabel?: (r: R) => string;
  sort?: SortState | undefined;
  onSort?: (s: SortState) => void;
  /** Client paging: show this many, then "Show more". */
  pageSize?: number;
  /** With `pageSize`: the prototype's footer ("1–12 of 13", Prev / Page n / N / Next) instead of "Show more"; sortable headers carry the ↕ hint. Without `pageSize` it is only the count footer. */
  pager?: boolean;
  empty?: { title: string; text?: string; action?: ReactNode };
  /** Server paging: more rows exist on the server. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Total on the server, for the "Showing x of y" line. */
  total?: number;
}) {
  const uid = useId().replace(/:/g, "");
  const [own, setOwn] = useState<SortState | null | undefined>(undefined);
  const [shown, setShown] = useState(pageSize ?? 0);
  const [page, setPage] = useState(0);
  // a new page size or a different row count (a filter changed) starts the list over at the first page
  const [seen, setSeen] = useState(`${pageSize ?? 0}:${rows.length}`);
  if (seen !== `${pageSize ?? 0}:${rows.length}`) {
    setSeen(`${pageSize ?? 0}:${rows.length}`);
    setPage(0);
    setShown(pageSize ?? 0);
  }
  const [own1, setOwn1] = useState<string>("");
  const [overflow, setOverflow] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const cur = own === null ? undefined : (own ?? sort);
  const action = !!(onRow || rowHref);

  // keep the scroll region focusable only while it actually scrolls
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length, columns.length]);

  // rows whose first cell already has its own control do not get ours (no two tab stops for one action, no nested controls)
  useLayoutEffect(() => {
    if (!action || !scroller.current) return;
    const owned: string[] = [];
    scroller.current.querySelectorAll<HTMLElement>("tbody tr[data-key]").forEach((tr) => {
      const cell = tr.querySelector<HTMLElement>("td:first-child > .cell-content");
      if (cell?.querySelector(INTERACTIVE)) owned.push(tr.dataset.key ?? "");
    });
    const sig = owned.join("\u0000");
    if (sig !== own1) setOwn1(sig);
  }, [action, rows, columns, own1, shown]);

  if (!rows.length) return <div className="dtable-wrap" id={id}><Empty title={empty?.title ?? "Nothing here"} text={empty?.text ?? "No rows match."} action={empty?.action} /></div>;
  const val = (c: Col<R>, r: R): number | string => (typeof c.sort === "function" ? c.sort(r) : ((r as Record<string, unknown>)[c.key] as number | string));
  const list = rows.slice();
  const col = cur ? columns.find((c) => c.key === cur.key) : undefined;
  if (cur && col) list.sort((a, b) => { const x = val(col, a); const y = val(col, b); return (x > y ? 1 : x < y ? -1 : 0) * cur.dir; });
  const pages = pager && pageSize ? Math.max(1, Math.ceil(list.length / pageSize)) : 1;
  const pg = Math.min(page, pages - 1);
  const visible = pager ? (pageSize ? list.slice(pg * pageSize, (pg + 1) * pageSize) : list) : shown ? list.slice(0, shown) : list;
  const pick = (key: string, dir?: 1 | -1): void => {
    const active = cur?.key === key;
    const next: SortState = { key, dir: dir ?? (active ? (cur!.dir === 1 ? -1 : 1) : 1) };
    setOwn(next);
    onSort?.(next);
  };
  const prefix = id ? `${id}-sort-` : null;
  const ownedKeys = new Set(own1 ? own1.split("\u0000") : []);
  const sortable = columns.filter((c) => c.sort);
  const regionProps = overflow ? { role: "region", tabIndex: 0, "aria-label": caption ?? "Table" } : {};
  const clientMore = !pager && shown && rows.length > shown;
  return (
    <div className="dtable-wrap" id={id}>
      {sortable.length ? (
        <label className="dtable-sortsel">
          <span>Sort by</span>
          <select className="input" value={cur?.key ?? ""} onChange={(e) => (e.target.value ? pick(e.target.value, cur?.key === e.target.value ? cur.dir : 1) : setOwn(null))}>
            <option value="">Default order</option>
            {sortable.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
      ) : null}
      <div ref={scroller} className={`tw dtable-scroll${overflow ? " is-overflow" : ""}`} {...regionProps}>
        <table className={`tbl cards dtable${action ? " is-clickable rowtr-all" : ""}`}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = cur?.key === c.key;
                return (
                  <th key={c.key} scope="col" className={`${c.align === "end" ? "is-end r" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined} style={c.width ? { width: c.width } : undefined} aria-sort={active ? (cur!.dir > 0 ? "ascending" : "descending") : undefined}>
                    {c.sort ? (
                      <button type="button" id={prefix ? prefix + c.key : undefined} className={`th-sort${active ? " is-active" : ""}`} onClick={() => pick(c.key)}>
                        {c.label}<span className="th-arrow" aria-hidden="true">{active ? (cur!.dir > 0 ? "↑" : "↓") : pager ? <span className="sorthint"> ↕</span> : ""}</span>
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const key = rowKey(r);
              const hasOwn = ownedKeys.has(key);
              return (
                <tr
                  key={key}
                  className={action ? "rowtr" : undefined}
                  data-key={key}
                  {...(rowId ? { id: rowId(r) } : {})}
                  {...(action ? { onClick: (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest(INTERACTIVE)) return; if (onRow) onRow(r); else if (rowHref) window.location.assign(rowHref(r)); } } : {})}
                >
                  {columns.map((c, i) => {
                    const content = c.render ? c.render(r) : ((r as Record<string, unknown>)[c.key] as ReactNode) ?? "";
                    const first = i === 0 && action && !hasOwn;
                    const lid = `${uid}-${key}`.replace(/[^\w-]/g, "_");
                    return (
                      <td key={c.key} data-label={c.label} data-l={c.label} className={`${c.align === "end" ? "is-end r" : ""}${i === 0 ? " pri-cell" : ""}${c.hideSmall ? " hide-sm" : ""}`.trim() || undefined}>
                        {i === 0 && action ? <span className="cell-content" id={first ? lid : undefined}>{content}</span> : content}
                        {first ? (
                          rowHref ? <a className="row-link" href={rowHref(r)} aria-labelledby={rowLabel ? undefined : lid} {...(rowLabel ? { "aria-label": rowLabel(r) } : {})} />
                          : <button type="button" className="row-link" aria-labelledby={rowLabel ? undefined : lid} {...(rowLabel ? { "aria-label": rowLabel(r) } : {})} onClick={() => onRow?.(r)} />
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager ? (
        <div className="tfoot dtable-pager">
          <span className="dtable-count" role="status">{`${pg * (pageSize ?? list.length) + 1}–${pg * (pageSize ?? list.length) + visible.length} of ${list.length}`}</span>
          {pages > 1 ? (
            <div className="row">
              <button type="button" className="btn sm btn-sm" id={`${id ?? "dt"}-prev`} disabled={pg === 0} onClick={() => setPage(pg - 1)}>Prev</button>
              <span>{`Page ${pg + 1} / ${pages}`}</span>
              <button type="button" className="btn sm btn-sm" id={`${id ?? "dt"}-next`} disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {clientMore || hasMore ? (
        <div className="tfoot dtable-more">
          <span className="dtable-count" role="status">{total ? `Showing ${visible.length} of ${total}` : `Showing ${visible.length}${clientMore ? ` of ${rows.length}` : ""}`}</span>
          {clientMore ? (
            <button type="button" className="btn sm btn-sm" id={`${id ?? "dt"}-more`} onClick={() => setShown(shown + (pageSize ?? 0))}>{`Show ${Math.min(pageSize ?? 0, rows.length - shown)} more of ${rows.length - shown}`}</button>
          ) : (
            <button type="button" className="btn sm btn-sm" id={`${id ?? "dt"}-more`} aria-disabled={loadingMore ? "true" : undefined} onClick={() => { if (!loadingMore) onLoadMore?.(); }}>{loadingMore ? "Loading..." : "Load more"}</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
