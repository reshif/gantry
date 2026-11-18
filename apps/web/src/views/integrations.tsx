/**
 * Integrations (spec 8.8, 12.1), the Control Room screen: head with Add integration, four stat tiles (Connected, Healthy, Degraded,
 * Failing), a filter bar (search, Type, Status) and a sortable table of connections. A connection opens in a drawer (status, banner,
 * Projects / Secret / Connected by / Last sync, Test connection, Disconnect…); edit, enable and usage sit in a disclosure in that drawer.
 * The connector catalogue and the custom-type builder stay available behind the Catalogue and Custom types buttons (`?view=`).
 * Tab, search, filters, sort, page and the open drawer live in the URL (F-15).
 */
import { useState } from "react";
import type { IntegrationInstance } from "@gantry/domain";
import { useCan } from "../api/can";
import { ops } from "../api/ops";
import { Btn, FilterBar, SearchBox, Select, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { DataTable } from "../ui/DataTable";
import { Page, Stats } from "../ui/cr";
import { Dialog } from "../ui/Overlay";
import { useUI } from "../ui/overlay-context";
import { AddIntegration } from "./integrations/AddDialog";
import { InstanceDrawer, RemoveIntegration, TypeDrawer } from "./integrations/Instance";
import { CatalogueTab, CustomTab } from "./integrations/Tabs";
import { Health, statusOf, useIntegrationData, type TypeRow } from "./integrations/kit";
import { agoShort, oneOf, sortFrom, useUrlState } from "./connect/kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const STATUSES = ["healthy", "degraded", "failing", "offline", "disabled"] as const;
/** The prototype offers healthy, degraded and failing; offline and disabled are listed only when a connection is in that state. */
const CORE_STATUSES = ["healthy", "degraded", "failing"] as const;
const VIEWS = ["connected", "catalogue", "custom"] as const;

export default function IntegrationsView() {
  const ui = useUI();
  const d = useIntegrationData();
  const add = dec(useCan("integration.add"));
  const url = useUrlState({ view: "connected", q: "", type: "all", st: "all", sort: "", dir: "", page: "0" });
  const view = oneOf(url.v.view, VIEWS, "connected");
  const [cq, setCq] = useState("");
  const [ccat, setCcat] = useState("all");
  const [cst, setCst] = useState("all");

  const openInstance = (id: string): void => {
    ui.drawer.open(`int:${id}`, (close) => (
      <InstanceDrawer id={id} close={close} onRemove={(i: IntegrationInstance) => { close(); ui.open((c) => <RemoveIntegration inst={i} close={c} />); }} />
    ));
  };
  const addDialog = (_typeId: string | null): void => {
    ui.open((close) => <AddIntegration types={d.types} close={close} />);
  };
  const openType = (id: string): void => {
    ui.drawer.open(`int-type:${id}`, (close) => (
      <TypeDrawer
        id={id} close={close} onAdd={addDialog} onOpen={openInstance}
        onRemove={(t: TypeRow) => ui.open((c) => (
          <Dialog title={`Remove ${t.name} from the catalogue?`} kicker="Integrations · custom type" onClose={c} actions={[{ label: "Cancel" }, { label: "Remove type", kind: "danger", id: "int-t-remove-go", guard: add, onClick: async () => {
            const r = await ops.removeIntegrationType(t.id);
            ui.toast(r.msg, r.ok ? "ok" : "error");
            if (r.ok) { c(); close(); }
          } }]} body={<p>No connection uses it. New connections of this type can no longer be added. The removal is audited.</p>} />
        ))}
      />
    ));
  };

  const all = d.insts;
  const typeIds = Array.from(new Set(all.map((i) => i.type)));
  const type = oneOf(url.v.type, ["all", ...typeIds], "all");
  const st = oneOf(url.v.st, ["all", ...STATUSES], "all");
  const needle = url.v.q.trim().toLowerCase();
  const rows = all.filter((i) => (type === "all" || i.type === type) && (st === "all" || statusOf(i) === st) && (!needle || `${i.name} ${i.type} ${i.projects === "all" ? "all" : i.projects.join(" ")}`.toLowerCase().includes(needle)));
  const filtered = !!(url.v.q || type !== "all" || st !== "all");
  const count = (s: string): number => all.filter((i) => statusOf(i) === s).length;
  const stat = (n: number): string => String(n);

  const connected = (
    <>
      <FilterBar label="Filter integrations" count={`${rows.length} of ${all.length}`} actions={(
        <>
          {filtered ? <Btn label="Clear" small kind="ghost" id="int-clear" onClick={() => url.clear("view")} /> : null}
        </>
      )}>
        <SearchBox id="int-q" label="Search integrations" placeholder="Search integrations" value={url.v.q} onChange={(q) => url.set({ q })} />
        <Select id="int-type" aria-label="Type" value={type} options={[{ value: "all", label: "Type: all" }, ...typeIds.map((t) => ({ value: t, label: t }))]} onChange={(v) => url.set({ type: v })} />
        <Select id="int-status" aria-label="Status" value={st} options={[{ value: "all", label: "Status: all" }, ...STATUSES.filter((s) => (CORE_STATUSES as readonly string[]).includes(s) || all.some((i) => statusOf(i) === s)).map((s) => ({ value: s, label: s }))]} onChange={(v) => url.set({ st: v })} />
      </FilterBar>
      <DataTable<IntegrationInstance>
        id="int-table"
        caption="Connected integrations"
        rows={rows}
        rowKey={(i) => i.id}
        rowId={(i) => `int-row-${i.id}`}
        pageSize={12}
        pager
        idleGlyph
        page={Math.max(0, Number(url.v.page) || 0)}
        onPage={(p) => url.set({ page: String(p) })}
        sort={sortFrom(url.v.sort, url.v.dir, "name", 1)}
        onSort={(s) => url.set({ sort: s.key, dir: s.dir === 1 ? "asc" : "desc", page: "0" })}
        empty={all.length && filtered ? { title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="clear-filters" onClick={() => url.clear("view")} /> } : { title: "Nothing connected", text: "Add an integration to start." }}
        columns={[
          { key: "name", label: "Integration", sort: (i) => i.name.toLowerCase(), render: (i) => <a className="rl ell" id={`int-open-${i.id}`} href="#integrations" onClick={(e) => { e.preventDefault(); openInstance(i.id); }}>{i.name}</a> },
          { key: "type", label: "Type", sort: (i) => i.type, hideSmall: true, render: (i) => <span className="tag">{i.type}</span> },
          { key: "projects", label: "Projects", sort: (i) => (i.projects === "all" ? "all" : i.projects.join(", ")), render: (i) => <span className="ell">{i.projects === "all" ? "all" : i.projects.join(", ")}</span> },
          { key: "last", label: "Last sync", sort: (i) => i.lastSync, render: (i) => <span className="mono dim">{agoShort(i.lastSync)}</span> },
          { key: "status", label: "Status", sort: (i) => statusOf(i), render: (i) => <Health st={statusOf(i)} /> },
        ]}
      />
    </>
  );

  return (
    <Page
      eyebrow="Connect" title="Integrations" sub="Source control, chat, trackers, paging and webhooks that the line talks to." cls="int-view"
      acts={<Btn label="Add integration" kind="primary" icon="plus" id="int-add" guard={add} onClick={() => addDialog(null)} />}
    >
      <Stats id="int-stats" items={[
        { l: "Connected", v: qState(d.instsQ, () => stat(all.length)), tone: "info" },
        { l: "Healthy", v: qState(d.instsQ, () => stat(count("healthy"))), tone: "ok" },
        { l: "Degraded", v: qState(d.instsQ, () => stat(count("degraded"))), tone: "warn" },
        { l: "Failing", v: qState(d.instsQ, () => stat(count("failing"))), tone: "bad" },
      ]} />
      {view !== "connected" ? (
        <div className="row" style={{ marginBottom: 12 }}><Btn label="Back to connected" small kind="ghost" icon="arrow-left" id="int-view-back" onClick={() => url.set({ view: "connected" })} /><span className="dim">{view === "catalogue" ? "Connector catalogue" : "Custom integration types"}</span></div>
      ) : null}
      {view === "catalogue" ? (
        <Async query={d.typesQ} what="the integration catalogue" id="int-cat">{() => <CatalogueTab nav={{ q: cq, setQ: setCq, cat: ccat, setCat: setCcat, status: cst, setStatus: setCst }} openType={openType} onAdd={addDialog} goBuild={() => url.set({ view: "custom" })} />}</Async>
      ) : view === "custom" ? (
        <Async query={d.typesQ} what="custom integration types" id="int-custom">{() => <CustomTab onAddInstance={addDialog} openType={openType} />}</Async>
      ) : (
        <Async query={d.instsQ} what="connected integrations" id="int">{() => connected}</Async>
      )}
    </Page>
  );
}
