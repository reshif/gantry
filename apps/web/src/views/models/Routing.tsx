/**
 * Routing policy (legacy routingPanel, spec 10.4): factory default, station overrides, class overrides, fallback order, residency rules and the route preview.
 * The preview asks the API (GET /routing/resolve), which is the same resolver the model gateway uses, so it cannot disagree with what a run gets.
 * Every edit saves a new routing version with If-Match; a stale screen is refused.
 */
import { useState } from "react";
import { fmt, type Agent, type Catalog, type Project, type Repo, type Routing, type Vendor } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useRoutingResolve, useRoutingVersions } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { Btn, Empty, Field, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ProjectPolicy } from "./Policy";
import { dec, enabledModels, repoTags } from "./kit";

type RoutingRead = Routing & { version?: number };

export function RoutingPanel({ routing, vendors, agents, repos, projects, cat }: { routing: RoutingRead; vendors: Vendor[]; agents: Agent[]; repos: Repo[]; projects: Project[]; cat: Catalog | null }) {
  const ui = useUI();
  const perm = dec(useCan("model.edit"));
  const ro = !perm.allowed;
  const r = routing;
  const enabled = enabledModels(vendors);
  const vendorName = (id: string): string => vendors.find((v) => v.id === id)?.name ?? id;
  const modelOf = (id: string) => vendors.flatMap((v) => v.models.map((m) => ({ m, v }))).find((x) => x.m.id === id);

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
  const classes = cat?.classes ?? [];
  const stationLabel = (id: string): string => stations.find((s) => s.id === id)?.name ?? id;
  const withCurrent = (cur: string) => (cur && !enabled.some((m) => m.value === cur) ? [...enabled, { value: cur, label: `${cur} (unavailable)` }] : enabled);

  const defaultSel = (
    <Select id="rt-default" disabled={ro} options={withCurrent(r.defaultModel)} value={r.defaultModel}
      onChange={(v) => void change((x) => { x.defaultModel = v; }, `Default model is now ${v}.`, `Default model → ${v}`)} />
  );

  const overrides = (
    <div className="table-scroll">
      <table className="table table-compact">
        <thead><tr><th scope="col">Station</th><th scope="col">Model</th><th scope="col">Agent&apos;s own primary</th></tr></thead>
        <tbody>
          {stations.map((st) => {
            const cur = r.overrides[st.id] ?? "";
            const ag = agents.find((a) => a.id === st.agent);
            return (
              <tr key={st.id}>
                <td className="nowrap">
                  <span className="mono muted">{st.no} </span>
                  {st.name}
                  {st.custom ? <span className="tag">{projects.find((p) => p.id === st.project)?.name ?? st.project}</span> : null}
                </td>
                <td>
                  <Select id={`rt-st-${st.id}`} aria-label={`${st.name} model`} disabled={ro} options={[{ value: "", label: `Default (${r.defaultModel})` }, ...withCurrent(cur)]} value={cur}
                    onChange={(v) => void change((x) => { if (v) x.overrides[st.id] = v; else delete x.overrides[st.id]; }, `${st.name} now uses ${v || "the default"}.`, `${st.name} → ${v || "default"}`)} />
                </td>
                <td>{ag ? <span className="mono small">{ag.model}</span> : <span className="muted small">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const classTable = (
    <div className="table-scroll">
      <table className="table table-compact" id="rt-classes">
        <thead><tr><th scope="col">Work class</th><th scope="col">Model</th></tr></thead>
        <tbody>
          {classes.map((c) => {
            const cur = r.classOverrides?.[c.id] ?? "";
            return (
              <tr key={c.id}>
                <td className="nowrap">{c.name}</td>
                <td>
                  <Select id={`rt-cl-${c.id}`} aria-label={`${c.name} model`} disabled={ro} options={[{ value: "", label: "No class override" }, ...withCurrent(cur)]} value={cur}
                    onChange={(v) => void change((x) => { x.classOverrides = { ...(x.classOverrides ?? {}) }; if (v) x.classOverrides[c.id] = v; else delete x.classOverrides[c.id]; }, `${c.name} work now uses ${v || "no class override"}.`, `Class ${c.id} → ${v || "none"}`)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const fb = (
    <ol className="chain">
      {r.fallback.map((m, i) => {
        const mm = modelOf(m);
        const ok = !!mm && mm.m.enabled && mm.v.connected;
        return (
          <li key={m}>
            <span className="mono chain-n">{i + 1}</span>
            <span className="mono">{m}</span>
            {ok ? null : <span className="chip chip-warn">unavailable, skipped</span>}
            <span className="chain-tools">
              <Btn small icon="up" id={`rt-fb-up-${i}`} aria={`Move ${m} up`} disabledReason={ro ? perm.reason : i === 0 ? "Already first." : null}
                onClick={() => void change((x) => { x.fallback.splice(i, 1); x.fallback.splice(i - 1, 0, m); }, "Fallback order changed.", `Fallback order: ${m} up`)} />
              <Btn small icon="down" id={`rt-fb-down-${i}`} aria={`Move ${m} down`} disabledReason={ro ? perm.reason : i === r.fallback.length - 1 ? "Already last." : null}
                onClick={() => void change((x) => { x.fallback.splice(i, 1); x.fallback.splice(i + 1, 0, m); }, "Fallback order changed.", `Fallback order: ${m} down`)} />
              <Btn small icon="x" id={`rt-fb-rm-${i}`} aria={`Remove ${m}`} disabledReason={ro ? perm.reason : r.fallback.length < 2 ? "Keep at least one fallback." : null}
                onClick={() => void change((x) => { x.fallback.splice(i, 1); }, `${m} removed from the fallback order.`, `Removed ${m} from fallback`)} />
            </span>
          </li>
        );
      })}
    </ol>
  );
  const addable = enabled.filter((m) => !r.fallback.includes(m.value));
  const addFb = (
    <Select id="rt-fb-add" aria-label="Add model to fallback order" disabled={ro || !addable.length} options={[{ value: "", label: "Add to fallback order…" }, ...addable]} value=""
      onChange={(v) => { if (v) void change((x) => { x.fallback.push(v); }, `${v} added to the fallback order.`, `Added ${v} to fallback`); }} />
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
  const tags = new Set<string>(["regulated", "infra", "experimental", "pci"]);
  repos.forEach((rp) => repoTags(rp, projects).forEach((t) => tags.add(t)));
  const [draft, setDraft] = useState({ tag: "regulated", use: "bedrock", region: "", alt: "", note: "" });
  const rules = (
    <ul className="rule-cards">
      {r.rules.map((rule) => {
        const hits = repos.filter((rp) => repoTags(rp, projects).includes(rule.tag));
        return (
          <li key={rule.id} className="rule-card">
            <div className="rule-top"><span className="mono">{rule.id}</span><span className="tag">{rule.tag}</span></div>
            <p className="rule-text">
              Repos tagged <strong>{rule.tag}</strong> use <strong>{vendorName(rule.use) + (rule.region ? ` ${rule.region}` : "")}</strong>
              {rule.alt ? <span> or <strong>{vendorName(rule.alt)}</strong></span> : null} only.
            </p>
            {rule.note ? <p className="muted small">{rule.note}</p> : null}
            <p className="small">Applies to: <span className="mono">{hits.map((x) => x.name).join(", ") || "no repos yet"}</span></p>
            <Btn label="Remove rule" small kind="ghost" icon="x" id={`rr-del-${rule.id}`} guard={perm}
              onClick={() => void change((x) => { x.rules = x.rules.filter((y) => y.id !== rule.id); }, `${rule.id} removed.`, `Removed ${rule.id} (${rule.tag} → ${rule.use})`)} />
          </li>
        );
      })}
    </ul>
  );
  const addRule = async () => {
    if (ro) return;
    if (draft.alt && draft.alt === draft.use) { ui.toast("The alternative must be a different vendor.", "error"); return; }
    if (r.rules.some((x) => x.tag === draft.tag)) { ui.toast(`A rule for ${draft.tag} already exists. Remove it first.`, "error"); return; }
    const id = `RR-${r.rules.reduce((m, x) => Math.max(m, +x.id.slice(3) || 0), 0) + 1}`;
    const rule = { id, tag: draft.tag, use: draft.use, region: draft.region.trim(), alt: draft.alt, note: draft.note.trim() };
    const res = await change((x) => { x.rules.push(rule); }, `${id} added.`, `Added ${id}: ${rule.tag} → ${rule.use}${rule.region ? ` ${rule.region}` : ""}${rule.alt ? ` or ${rule.alt}` : ""}`);
    if (res.ok) setDraft({ tag: "regulated", use: "bedrock", region: "", alt: "", note: "" });
  };
  const vendorOpts = vendors.map((v) => ({ value: v.id, label: v.name }));
  const form = (
    <form className="rule-form md-rule-form" id="rr-form" onSubmit={(e) => { e.preventDefault(); void addRule(); }}>
      <Field label="When repo is tagged" htmlFor="rr-tag"><Select id="rr-tag" disabled={ro} options={[...tags]} value={draft.tag} onChange={(v) => setDraft((d) => ({ ...d, tag: v }))} /></Field>
      <Field label="Use only" htmlFor="rr-use"><Select id="rr-use" disabled={ro} options={vendorOpts} value={draft.use} onChange={(v) => setDraft((d) => ({ ...d, use: v }))} /></Field>
      <Field label="Region (optional)" htmlFor="rr-region"><input id="rr-region" className="input mono" placeholder="eu-central-1" value={draft.region} disabled={ro} onChange={(e) => setDraft((d) => ({ ...d, region: e.target.value }))} /></Field>
      <Field label="Or else" htmlFor="rr-alt"><Select id="rr-alt" disabled={ro} options={[{ value: "", label: "No alternative" }, ...vendorOpts]} value={draft.alt} onChange={(v) => setDraft((d) => ({ ...d, alt: v }))} /></Field>
      <Field label="Note" htmlFor="rr-note"><input id="rr-note" className="input" placeholder="Why this rule exists" value={draft.note} disabled={ro} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} /></Field>
      <Btn label="Add rule" kind="primary" type="submit" icon="plus" id="rr-add" guard={perm} />
    </form>
  );

  return (
    <div className="md-routing" id="rt-panel">
      <LockNote decision={perm} what="Routing" />
      <div className="md-tb">
        <div className="md-col">
          <Panel title="Defaults and overrides" cls="md-routing-defaults">
            <Field label="Factory default model" htmlFor="rt-default" hint="Used by any station without an override and by new agents.">{defaultSel}</Field>
            <h3 className="sub-h">Per-station overrides</h3>
            {overrides}
            <h3 className="sub-h">Per-class overrides</h3>
            <p className="muted small">A work-order class overrides its station. Order: factory default, project, station, class.</p>
            {classTable}
          </Panel>
          <Panel title="Fallback order">
            <p className="muted small">Tried in order when a model errors, times out or its vendor is down, and only if the project allows a different model. The same model on another allowed vendor is always tried first.</p>
            {fb}
            {addFb}
            {cross}
          </Panel>
        </div>
        <div className="md-col">
          <Panel title="Residency and routing rules">
            {r.rules.length ? rules : <Empty icon="globe" title="No residency rules" text="Without a rule, any allowed vendor can serve any repo." />}
            {form}
          </Panel>
          <Panel title="Per-project policy">
            <ProjectPolicy routing={r} vendors={vendors} projects={projects} enabled={enabled} change={change} />
          </Panel>
          <RoutingVersions current={r.version} />
          <Panel title="Where would this request go?">
            <Preview repos={repos} projects={projects} stations={stations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}${s.custom ? ` (${projects.find((p) => p.id === s.project)?.name ?? s.project})` : ""}` }))} stationLabel={stationLabel} />
          </Panel>
        </div>
      </div>
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
