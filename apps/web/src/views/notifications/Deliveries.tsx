/** The Deliveries tab (prototype): search, status filter, sortable table with the Retry action; search, status, sort and page live in the URL (F-15). */
import { type Delivery, type Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useDeliveries } from "../../api/queries";
import { ops } from "../../api/ops";
import { Async, qState } from "../../ui/async";
import { DataTable } from "../../ui/DataTable";
import { Btn, Chip, FilterBar, SearchBox, Select, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { agoShort, oneOf, sortFrom, useUrlState } from "../connect/kit";
import { evName } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
export const dlStatus = (d: Delivery): "delivered" | "failed" | "retrying" | "pending" => (d.status === "failed" ? (d.state === "failed" && d.attempts > 0 ? "retrying" : "failed") : d.status === "pending" ? "pending" : "delivered");
const WORD = { delivered: "Delivered", failed: "Failed", retrying: "Retrying", pending: "Pending" } as const;
const TONE = { delivered: "ok", failed: "bad", retrying: "warn", pending: "info" } as const;
const STATUSES = ["delivered", "failed", "retrying", "pending"] as const;

export function DeliveriesTab({ p, url }: { p: Project; url: ReturnType<typeof useUrlState<"tab" | "q" | "st" | "sort" | "dir" | "page" | "view">> }) {
  const ui = useUI();
  const perm = dec(useCan("notify.edit", { project: p.id }));
  const q = useDeliveries({ project: p.id, limit: 200 });
  const all = Array.isArray(q.data) ? q.data : q.data?.items ?? [];
  const st = oneOf(url.v.st, ["all", ...STATUSES], "all");
  const needle = url.v.q.trim().toLowerCase();
  const rows = all.filter((d) => (st === "all" || dlStatus(d) === st) && (!needle || `${d.id} ${d.event} ${d.target}`.toLowerCase().includes(needle)));
  const filtered = !!(needle || st !== "all");
  const retry = async (d: Delivery): Promise<void> => {
    const r = await ops.retryDelivery(d.id);
    ui.toast(r.ok ? `Redelivered ${d.id}` : r.msg, r.ok ? "ok" : "error");
  };
  return (
    <>
      <FilterBar label="Filter deliveries" count={`${qState(q, () => String(rows.length))} of ${qState(q, () => String(all.length))}`} actions={filtered ? <Btn label="Clear" small kind="ghost" id="nt-dl-clear" onClick={() => url.clear("tab")} /> : null}>
        <SearchBox id="nt-dl-q" label="Search deliveries" placeholder="Search deliveries" value={url.v.q} onChange={(v) => url.set({ q: v })} />
        <Select id="nt-dl-status" aria-label="Status" options={[{ value: "all", label: "Status: all" }, ...STATUSES.map((s) => ({ value: s, label: s }))]} value={st} onChange={(v) => url.set({ st: v })} />
      </FilterBar>
      <Async query={q} what="the delivery log" id="nt-dl">{() => (
        <DataTable<Delivery>
          id="nt-dl-table"
          caption="Delivery log"
          rows={rows}
          rowKey={(d) => d.id}
          rowId={(d) => `nt-dl-${d.id}`}
          pageSize={10}
          pager
          page={Math.max(0, Number(url.v.page) || 0)}
          onPage={(n) => url.set({ page: String(n) })}
          sort={sortFrom(url.v.sort, url.v.dir, "at", -1)}
          onSort={(s) => url.set({ sort: s.key, dir: s.dir === 1 ? "asc" : "desc", page: "0" })}
          empty={filtered ? { title: "Nothing matches", text: "Try clearing a filter or searching for something else." } : { title: "No deliveries yet", text: "Deliveries appear here once an event is sent." }}
          columns={[
            { key: "id", label: "ID", sort: (d) => d.id, render: (d) => <span className="mono">{d.id}</span> },
            { key: "at", label: "When", sort: (d) => d.at, render: (d) => <span className="mono dim">{agoShort(d.at)}</span> },
            { key: "event", label: "Event", sort: (d) => evName(d.event), render: (d) => evName(d.event) },
            { key: "channel", label: "Channel", sort: (d) => d.channel, render: (d) => <span className="tag">{d.channel}</span> },
            { key: "target", label: "Target", sort: (d) => d.target, render: (d) => <span className="mono ell">{d.target}</span> },
            { key: "st", label: "Status", sort: (d) => dlStatus(d), render: (d) => <Chip cls={TONE[dlStatus(d)]} text={WORD[dlStatus(d)]} /> },
            { key: "act", label: "", align: "end", render: (d) => (d.status === "failed" ? <Btn label="Retry" small icon="refresh" id={`nt-retry-${d.id}`} guard={perm} onClick={() => void retry(d)} /> : null) },
          ]}
        />
      )}</Async>
    </>
  );
}
