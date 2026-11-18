/**
 * Routing policy (legacy routingPanel, spec 10.4): factory default, station overrides, class overrides, fallback order, residency rules and the route preview.
 * The preview asks the API (GET /routing/resolve), which is the same resolver the model gateway uses, so it cannot disagree with what a run gets.
 * Every edit saves a new routing version with If-Match; a stale screen is refused.
 */
import { Fragment, useState } from "react";
import { fmt, type Catalog, type Project, type Repo, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useRoutingResolve, useRoutingVersions } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { Chip, Field, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ProjectPolicy } from "./Policy";
import { dec, enabledModels, repoTags } from "./kit";

type RoutingRead = Routing & { version?: number };

export function RoutingPanel({ routing, vendors, repos, projects, cat }: { routing: RoutingRead; vendors: Vendor[]; repos: Repo[]; projects: Project[]; cat: Catalog | null }) {
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
  const stationLabel = (id: string): string => stations.find((s) => s.id === id)?.name ?? id;
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

  const cross = (
    <div className="md-cross" id="rt-cross-row">
      <Toggle id="rt-cross" checked={r.crossModelFallback === true} label="Allow fallback to a different model" decision={ro ? perm : null}
        onChange={(on) => void change((x) => { if (on) x.crossModelFallback = true; else delete x.crossModelFallback; }, on ? "Cross-model fallback is allowed where a project opts in." : "Cross-model fallback is off.", `Cross-model fallback ${on ? "on" : "off"}`)} />
      <span className="small">
        <strong>Different-model fallback</strong>
        <span className="muted"> is off. Calls fall back only to the same model on another allowed vendor. Turn it on here, then each project that wants it opts in. Runs served by a different model are flagged.</span>
      </span>
    </div>
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
          {cross}
        </Panel>
      </div>
      <Panel title="Routing rules" flush>
        {rules}
      </Panel>
      <div className="cols">
        <Panel title="Per-project policy">
          <ProjectPolicy routing={r} vendors={vendors} projects={projects} enabled={enabled} change={change} />
        </Panel>
        <Panel title="Where would this request go?">
          <Preview repos={repos} projects={projects} stations={stations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}${s.custom ? ` (${projects.find((p) => p.id === s.project)?.name ?? s.project})` : ""}` }))} stationLabel={stationLabel} />
        </Panel>
      </div>
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

function Preview({ repos, projects, stations, stationLabel }: { repos: Repo[]; projects: Project[]; stations: Array<{ value: string; label: string }>; stationLabel: (id: string) => string }) {
  const [station, setStation] = useState("build");
  const [repoId, setRepoId] = useState<string | null>(null);
  const defaultRepo = (repos.find((x) => repoTags(x, projects).includes("regulated")) ?? repos[0])?.id ?? "";
  const repo = repos.find((x) => x.id === repoId)?.id ?? defaultRepo;
  const q = useRoutingResolve({ station, ...(repo ? { repo } : {}) }, !!station);
  const res = q.data;
  return (
    <div className="md-preview">
      <div className="form-row">
        <Field label="Station" htmlFor="rt-prev-station"><Select id="rt-prev-station" options={stations.length ? stations : [{ value: station, label: stationLabel(station) }]} value={station} onChange={setStation} /></Field>
        <Field label="Repo" htmlFor="rt-prev-repo"><Select id="rt-prev-repo" options={repos.map((x) => ({ value: x.id, label: x.name + (repoTags(x, projects).length ? ` [${repoTags(x, projects).join(", ")}]` : "") }))} value={repo} onChange={setRepoId} /></Field>
      </div>
      <ol className="md-steps">{(res?.steps ?? []).map((t, i) => <li key={i}>{t}</li>)}</ol>
      {res ? (
        <div className={`md-result ${res.model ? "is-ok" : "is-block"}`}>
          <Icon name={res.model ? "check" : "lock"} />
          <span>{res.model ? "Requests go to " : "Blocked: "}</span>
          <strong className="mono">{res.model || "no allowed model"}</strong>
          {res.crossModel ? <span className="chip chip-warn">different model, flagged</span> : null}
        </div>
      ) : <div className="md-result" role="status"><span>{q.isError ? "The route could not be worked out." : "Working out the route…"}</span></div>}
      <p className="muted small">Order: factory default, project, station, class. Then the filter on the project&apos;s vendors, regions and retention; residency rules always win.</p>
    </div>
  );
}
