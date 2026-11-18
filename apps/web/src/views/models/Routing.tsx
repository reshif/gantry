/**
 * Routing policy (legacy routingPanel, spec 10.4): factory default, station overrides, class overrides, fallback order, residency rules and the route preview.
 * The preview asks the API (GET /routing/resolve), which is the same resolver the model gateway uses, so it cannot disagree with what a run gets.
 * Every edit saves a new routing version with If-Match; a stale screen is refused.
 */
import { Fragment } from "react";
import { fmt, type Catalog, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useRoutingVersions } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { Chip, LockNote, Panel, Select } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { useUI } from "../../ui/overlay-context";
import { dec, enabledModels } from "./kit";

type RoutingRead = Routing & { version?: number };

export function RoutingPanel({ routing, vendors, cat }: { routing: RoutingRead; vendors: Vendor[]; cat: Catalog | null }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const ro = !perm.allowed;
  const r = routing;
  const enabled = enabledModels(vendors).map((m) => ({ value: m.value, label: m.label.replace(/ · [^·]*$/, "") }));

  /** Apply fn to a copy of the routing and save it as a new version. */
  const change = async (fn: (x: Routing) => void, msg: string, label = msg) => {
    const { version, ...rest } = r;
    const next = JSON.parse(JSON.stringify(rest)) as Routing;
    fn(next);
    const res = await ops.setRouting(next as unknown as Record<string, unknown>, label, version !== undefined ? { ifMatch: version } : undefined);
    ui.toast(res.ok ? msg : res.msg, res.ok ? "ok" : "error");
    return res;
  };

  const stations = cat?.stations ?? [];
  const withCurrent = (cur: string) => (cur && !enabled.some((m) => m.value === cur) ? [...enabled, { value: cur, label: `${cur} (unavailable)` }] : enabled);

  const defaultSel = (
    <Select id="rt-default" aria-label="Default model" disabled={ro} options={withCurrent(r.defaultModel)} value={r.defaultModel}
      onChange={(v) => void change((x) => { x.defaultModel = v; }, "Default model updated", `Default model → ${v}`)} />
  );

  const overrides = (
    <>
      {stations.filter((st) => !st.custom).map((st) => {
        const cur = r.overrides[st.id] ?? "";
        return (
          <Fragment key={st.id}>
            <dt>{st.name}</dt>
            <dd>
              <Select id={`rt-st-${st.id}`} aria-label={`${st.name} model`} disabled={ro} options={[{ value: "", label: "Use default" }, ...withCurrent(cur)]} value={cur}
                onChange={(v) => void change((x) => { if (v) x.overrides[st.id] = v; else delete x.overrides[st.id]; }, `${st.name} routing saved`, `${st.name} → ${v || "default"}`)} />
            </dd>
          </Fragment>
        );
      })}
    </>
  );

  // ---- residency and routing rules
  const ruleCols: SortCol<Routing["rules"][number]>[] = [
    { key: "tag", label: "Repo tag", render: (x) => <Chip text={x.tag} cls="info" /> },
    { key: "use", label: "Use vendor", render: (x) => x.use + (x.alt ? ` or ${x.alt}` : "") },
    { key: "region", label: "Region", render: (x) => x.region || "—" },
    { key: "note", label: "Why", render: (x) => x.note || "—" },
  ];
  const rules = (
    <DataTable id="rr-table" caption="Routing rules" columns={ruleCols} rows={r.rules} rowKey={(x) => x.id} pageSize={12} pager sortSelect={false}
      empty={{ title: "No residency rules", text: "Without a rule, any allowed vendor can serve any repo." }} />
  );

  return (
    <div className="stack md-routing" id="rt-panel">
      <LockNote decision={perm} what="Routing" />
      <div className="cols">
        <Panel title="Default and per-station">
          <dl className="kv">
            <dt>Default model</dt><dd>{defaultSel}</dd>
            {overrides}
          </dl>
        </Panel>
        <Panel title="Fallback chain">
          <ol className="mono" style={{ margin: 0, paddingLeft: 20 }}>
            {r.fallback.map((f) => <li key={f} style={{ padding: "6px 0" }}>{f}</li>)}
          </ol>
        </Panel>
      </div>
      <Panel title="Routing rules" flush>
        {rules}
      </Panel>
      <RoutingVersions current={r.version} />
    </div>
  );
}

/** Every published routing version, newest first. Read-only: each edit above publishes the next one. */
function RoutingVersions({ current }: { current: number | undefined }) {
  const q = useRoutingVersions();
  const actor = useActors();
  const rows = Array.isArray(q.data) ? q.data : [];
  return (
    <Panel title="Routing versions">
      <p className="muted small">Each edit to the routing policy is published as a new version with a change note. Runs are routed by the version in force.</p>
      <div className="table-scroll">
        <table className="table table-compact" id="rv-table">
          <thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">By</th><th scope="col">Note</th></tr></thead>
          <tbody>
            {rows.length ? null : <tr><td colSpan={4} className="small muted">{q.isLoading ? "Loading versions." : "No routing version has been published yet."}</td></tr>}
            {rows.slice(0, 8).map((v) => (
              <tr key={v.version}>
                <td className="mono">v{v.version}{v.version === current ? <span className="chip chip-accent"> in force</span> : null}</td>
                <td className="mono small">{`${fmt.istDate(Date.parse(v.publishedAt))} ${fmt.ist(Date.parse(v.publishedAt))}`}</td>
                <td className="small">{v.publishedBy && v.publishedBy !== "system" ? actor(v.publishedBy).name : "System"}</td>
                <td className="small">{v.note || <span className="muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
