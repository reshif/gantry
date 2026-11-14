/** The selected server: settings and tools, scope, the access check and recent calls (legacy detail()). */
import { useState } from "react";
import { flowOf, classesOf, type Agent, type Catalog, type McpServer, type McpUsage, type Project, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useMcpAccessCheck } from "../../api/queries";
import { Btn, Empty, Field, LockNote, Panel, Select, Toggle, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { Health, Rw, SENS, classesFor, dec, draftOf, projectsIn, stationsFor, type ScopeDraft } from "./kit";
import { UsageTable } from "./Usage";

const WRITE_ALWAYS: Decision = { allowed: false, reason: "Write tools always need a station pre-authorisation for the work order and attempt (spec 12.4). There is no switch to turn it off." };

function ScopeGroup({ k, label, items, d, ro, allowAll, set }: { k: keyof ScopeDraft; label: string; items: Array<{ id: string; label: string; mono?: boolean }>; d: ScopeDraft; ro: boolean; allowAll: boolean; set: (next: ScopeDraft) => void }) {
  const all = d[k] === "all";
  const list = d[k] === "all" ? [] : (d[k] as string[]);
  return (
    <fieldset className="mcp-scope">
      <legend className="field-label">{label}</legend>
      {allowAll ? (
        <label className="check mcp-all" htmlFor={`mcp-sc-${k}-all`}>
          <input type="checkbox" id={`mcp-sc-${k}-all`} checked={all} disabled={ro} onChange={(e) => set({ ...d, [k]: e.target.checked ? "all" : [] })} />
          All, including new ones
        </label>
      ) : null}
      <div className="check-grid">
        {items.map((it) => (
          <label className="check" htmlFor={`mcp-sc-${k}-${it.id}`} key={it.id}>
            <input type="checkbox" id={`mcp-sc-${k}-${it.id}`} checked={all || list.includes(it.id)} disabled={ro || all}
              onChange={(e) => set({ ...d, [k]: e.target.checked ? [...list, it.id] : list.filter((x) => x !== it.id) })} />
            <span className={it.mono ? "mono small" : undefined}>{it.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface Props { srv: McpServer; cat: Catalog | null; projects: Project[]; agents: Agent[]; repos: Repo[]; calls: McpUsage[]; actorName: (id: string) => string; onRemoved: () => void }

export function Detail({ srv, cat, projects, agents, repos, calls, actorName, onRemoved }: Props) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const ro = !perm.allowed;
  const v = srv.version !== undefined ? { ifMatch: srv.version } : undefined;
  const show = (r: { ok: boolean; msg: string }, okMsg?: string): void => ui.toast(r.ok ? okMsg ?? r.msg : r.msg, r.ok ? "ok" : "error");

  // ---- scope draft
  const [draft, setDraft] = useState<ScopeDraft | null>(null);
  const base = draftOf(srv);
  const d = draft ?? base;
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  const live = projects.filter((p) => p.status !== "archived");
  const scopeRepos = repos.filter((r) => d.projects === "all" || d.projects.includes(r.project));
  const inScope = projectsIn(projects, d.projects);
  const strict = srv.sensitivity === "confidential" || srv.sensitivity === "restricted";
  const enabledIn = projects.filter((p) => (p.mcp ?? []).includes(srv.id));

  // ---- access check
  const [chk, setChk] = useState({ agent: agents.find((a) => a.id === "ag-build")?.id ?? agents[0]?.id ?? "", project: projects.find((p) => p.id === "payments")?.id ?? projects[0]?.id ?? "", repo: "", station: "", cls: "", tool: "" });
  const chkP = projects.find((p) => p.id === chk.project);
  const chkStations = cat && chkP ? flowOf(cat, chkP).active : [];
  const chkClasses = cat && chkP ? classesOf(cat, chkP) : [];
  const tool = srv.tools.some((t) => t.name === chk.tool) ? chk.tool : srv.tools[0]?.name ?? "";
  const station = chkStations.some((s) => s.id === chk.station) ? chk.station : chkStations[0]?.id ?? "";
  const repoChoices = repos.filter((r) => r.project === chk.project);
  const repo = repoChoices.some((r) => r.id === chk.repo) ? chk.repo : "";
  const cls = chkClasses.some((x) => x.id === chk.cls) ? chk.cls : "";
  const access = useMcpAccessCheck({ server: srv.id, tool, agent: chk.agent, project: chk.project, ...(repo ? { repo } : {}), station, ...(cls ? { cls } : {}) }, !!(tool && chk.agent && chk.project && station));
  const dc = access.data;

  const recent = calls.filter((u) => u.server === srv.id).slice(0, 8);
  const changed = srv.tools.filter((t) => t.changed);

  const saveScope = async () => {
    const patch: Record<string, unknown> = JSON.parse(JSON.stringify(d));
    if (Array.isArray(patch.stations) && cat) { const ok = stationsFor(cat, inScope).map((x) => x.id); patch.stations = (patch.stations as string[]).filter((id) => ok.includes(id)); }
    if (Array.isArray(patch.classes) && cat) { const ok = classesFor(cat, inScope).map((x) => x.id); patch.classes = (patch.classes as string[]).filter((id) => ok.includes(id)); }
    if (Array.isArray(patch.repos)) patch.repos = (patch.repos as string[]).filter((id) => { const r = repos.find((x) => x.id === id); return !!r && (d.projects === "all" || d.projects.includes(r.project)); });
    const r = await ops.updateMCP(srv.id, patch, v);
    show(r, `Scope saved for ${srv.name}.`);
    if (r.ok) setDraft(null);
  };

  const remove = () => {
    const listing = agents.filter((a) => (a.mcp ?? []).includes(srv.id));
    ui.open((close) => (
      <Dialog title={`Remove ${srv.name}?`} kicker="MCP registry" onClose={close} actions={[
        { label: "Cancel" },
        { label: "Remove server", kind: "danger", id: "mcp-remove-go", guard: perm, onClick: async () => { const r = await ops.removeMCP(srv.id, v); show(r); if (r.ok) { onRemoved(); close(); } } },
      ]} body={(
        <div className="form-grid">
          <p>{`Agents lose access immediately. ${listing.length ? `${listing.length} agent${listing.length > 1 ? "s" : ""} list it: ${listing.map((a) => a.name).join(", ")}.` : "No agent lists it."}`}</p>
          {enabledIn.length ? <p>Enabled in {enabledIn.map((p) => p.name).join(", ")}. It is switched off there too. The removal is audited and its logged calls stay.</p> : null}
        </div>
      )} />
    ));
  };

  const approve = () => {
    ui.open((close) => (
      <Dialog title={`Re-approve ${srv.name}?`} kicker="MCP registry" onClose={close} actions={[
        { label: "Cancel" },
        { label: "Approve changed definitions", kind: "primary", id: "mcp-approve-go", guard: perm, onClick: async () => { const r = await ops.approveMCP(srv.id, v); show(r); if (r.ok) close(); } },
      ]} body={(
        <div className="form-grid">
          <p>The server now describes these tools differently from what was approved: <span className="mono">{changed.map((t) => t.name).join(", ") || "its address changed"}</span>. A changed description can change what an agent does with a tool.</p>
          <p className="muted small">Gantry connects again and accepts exactly what the server reports now. If it changed once more since you looked, the approval is refused.</p>
        </div>
      )} />
    ));
  };

  return (
    <div className="mcp-detail">
      <Panel title={<span className="mcp-dh"><Icon name="server" />{srv.name}</span>} tools={<Health st={srv.health} />}>
        <div className="form-grid">
          <LockNote decision={perm} what="MCP server settings" />
          {srv.enabled === false ? (
            <div className="lock-note" role="status" id="mcp-disabled-note">
              <Icon name="lock" />
              <span>Disabled{srv.disabledReason ? `: ${srv.disabledReason}.` : "."} Agents cannot call it.{srv.disabledReason ? " An admin has to re-approve it." : ""}</span>
              {srv.disabledReason ? <Btn label="Review and re-approve" id="mcp-approve" small kind="primary" guard={perm} onClick={approve} /> : null}
            </div>
          ) : null}
          <dl className="titleblock mcp-tb">
            <div><dt>Transport</dt><dd className="mono">{srv.transport}</dd></div>
            <div><dt>URL</dt><dd className="mono" title={srv.url}>{srv.url}</dd></div>
            <div><dt>Auth</dt><dd>{srv.auth} · <span className="mono">{srv.authMask}</span></dd></div>
            <div><dt>Enabled in projects</dt><dd>{enabledIn.length ? enabledIn.map((p) => p.key).join(", ") : "none"}</dd></div>
            <div><dt>Protocol revision</dt><dd className="mono">{srv.protocolRevision || "not yet discovered"}</dd></div>
            <div><dt>Last discovery</dt><dd>{srv.discoveredAt ? new Date(srv.discoveredAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never"}{srv.healthDetail ? <div className="neg small">{srv.healthDetail}</div> : null}</dd></div>
          </dl>
          <div className="form-row mcp-row">
            <Field label="Sensitivity" htmlFor="mcp-sens"><Select id="mcp-sens" options={SENS} value={srv.sensitivity} disabled={ro} onChange={(x) => void ops.updateMCP(srv.id, { sensitivity: x }, v).then((r) => show(r, `${srv.name} is now ${x}.`))} /></Field>
            <div className="toggle-row mcp-wg">
              <div><strong>Write tools need a pre-authorisation</strong><div className="muted small">{strict ? "Confidential and restricted servers: " : ""}Each write call needs the station's pre-authorisation for the work order and attempt, and is never retried.</div></div>
              <Toggle id="mcp-writegate" checked label="Write tools need a pre-authorisation" decision={WRITE_ALWAYS} />
            </div>
          </div>
          <div className="form-row mcp-row">
            <div className="toggle-row mcp-wg">
              <div><strong>Enabled</strong><div className="muted small">A disabled server is not offered to any run.</div></div>
              <Toggle id="mcp-enabled" checked={srv.enabled !== false} label="Enabled"
                decision={ro ? perm : srv.disabledReason && srv.enabled === false ? { allowed: false, reason: "Re-approve the changed definitions to switch it back on." } : null}
                onChange={(on) => void ops.updateMCP(srv.id, { enabled: on }, v).then((r) => show(r, on ? `${srv.name} enabled.` : `${srv.name} disabled.`))} />
            </div>
            <Btn label="Check again" icon="search" id="mcp-recheck" guard={perm} onClick={() => void ops.rediscoverMCP(srv.id, v).then((r) => show(r))} />
          </div>
          <h3 className="sub-h">{`Tools (${srv.tools.length})`}</h3>
          <div className="table-scroll">
            <table className="table table-compact mcp-tools">
              <thead><tr><th>Tool</th><th>Class</th><th>Allowed</th><th>Calls</th></tr></thead>
              <tbody>
                {srv.tools.map((t, i) => {
                  const n = calls.filter((u) => u.server === srv.id && u.tool === t.name).length;
                  return (
                    <tr key={t.name} className={t.allowed ? "" : "mcp-denied"}>
                      <td className="mono" title={t.description || undefined}>{t.name}{t.changed ? <span className="chip chip-block" title="The server reports a different definition than the one approved"> changed</span> : null}</td>
                      <td>
                        <Rw write={t.write} />{" "}
                        <select id={`mcp-tool-class-${i}`} className="input mcp-class" aria-label={`Class of ${t.name}`} value={t.write ? "write" : "read"} disabled={ro}
                          onChange={(e) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, write: e.target.value === "write" }] }, v).then((r) => show(r, `${t.name} is now a ${e.target.value} tool.`))}>
                          <option value="read">read</option>
                          <option value="write">write</option>
                        </select>
                        {t.hint && (t.hint === "write") !== t.write ? <span className="muted small"> server suggests {t.hint}</span> : null}
                      </td>
                      <td>
                        <span className="mcp-allow">
                          <Toggle id={`mcp-tool-${i}`} checked={t.allowed} label={`Allow ${t.name}`} decision={perm}
                            onChange={(on) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, allowed: on }] }, v).then((r) => show(r, `${t.name}${on ? " allowed." : " denied."}`))} />
                          <span className={`small ${t.allowed ? "" : "neg"}`}>{t.allowed ? "allow" : "✕ deny"}</span>
                        </span>
                      </td>
                      <td className="mono num">{String(n)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-actions mcp-danger"><Btn label="Remove server" kind="danger" icon="x" id="mcp-remove" guard={perm} onClick={remove} /></div>
        </div>
      </Panel>

      <Panel title="Scope">
        <div className="form-grid">
          <p className="muted small">An agent may call this server only where every scope matches. Projects must also enable it in Project config.</p>
          <ScopeGroup k="projects" label="Projects" items={live.map((p) => ({ id: p.id, label: p.name }))} d={d} ro={ro} allowAll set={setDraft} />
          <ScopeGroup k="repos" label="Repos" items={scopeRepos.map((r) => ({ id: r.id, label: r.name, mono: true }))} d={d} ro={ro} allowAll set={setDraft} />
          <ScopeGroup k="agents" label="Agents" items={agents.map((a) => ({ id: a.id, label: a.name }))} d={d} ro={ro} allowAll={false} set={setDraft} />
          <ScopeGroup k="stations" label="Stations (from the flows of the projects in scope)" items={cat ? stationsFor(cat, inScope) : []} d={d} ro={ro} allowAll={false} set={setDraft} />
          <ScopeGroup k="classes" label="Work classes" items={cat ? classesFor(cat, inScope) : []} d={d} ro={ro} allowAll set={setDraft} />
          <div className="form-actions">
            {dirty ? <Btn label="Revert" id="mcp-sc-revert" onClick={() => setDraft(null)} /> : null}
            <Btn label="Save scope" kind="primary" id="mcp-sc-save" guard={perm.allowed && !dirty ? { allowed: false, reason: "No changes to save." } : perm} onClick={() => void saveScope()} />
          </div>
        </div>
      </Panel>

      <Panel title="Access check">
        <div className="form-grid">
          <div className="form-row">
            <Field label="Agent" htmlFor="mcp-chk-agent"><Select id="mcp-chk-agent" options={agents.map((a) => ({ value: a.id, label: a.name }))} value={chk.agent} onChange={(x) => setChk({ ...chk, agent: x })} /></Field>
            <Field label="Project" htmlFor="mcp-chk-project"><Select id="mcp-chk-project" options={projects.map((p) => ({ value: p.id, label: p.name }))} value={chk.project} onChange={(x) => setChk({ ...chk, project: x, repo: "" })} /></Field>
            <Field label="Repo" htmlFor="mcp-chk-repo"><Select id="mcp-chk-repo" options={[{ value: "", label: "Any repo" }, ...repoChoices.map((r) => ({ value: r.id, label: r.name }))]} value={repo} onChange={(x) => setChk({ ...chk, repo: x })} /></Field>
            <Field label="Station" htmlFor="mcp-chk-station"><Select id="mcp-chk-station" options={chkStations.map((s) => ({ value: s.id, label: `${s.no} ${s.name}` }))} value={station} onChange={(x) => setChk({ ...chk, station: x })} /></Field>
            <Field label="Class" htmlFor="mcp-chk-cls"><Select id="mcp-chk-cls" options={[{ value: "", label: "Any class" }, ...chkClasses.map((x) => ({ value: x.id, label: x.name }))]} value={cls} onChange={(x) => setChk({ ...chk, cls: x })} /></Field>
            <Field label="Tool" htmlFor="mcp-chk-tool"><Select id="mcp-chk-tool" options={srv.tools.map((t) => ({ value: t.name, label: t.name + (t.write ? " (write)" : "") }))} value={tool} onChange={(x) => setChk({ ...chk, tool: x })} /></Field>
          </div>
          <div className={`decision ${dc?.allowed ? "is-allowed" : "is-denied"}`} role="status" id="mcp-chk-result">
            {dc ? (
              <>
                <div className="decision-v"><Icon name={dc.allowed ? (dc.gated ? "gate" : "check") : "x"} />{dc.allowed ? (dc.gated ? "Allowed with a pre-authorisation" : "Allowed") : "Denied"}</div>
                <div>{dc.reason}</div>
                <div className="decision-rule small"><span className="kv-k">Deciding rule</span><span className="mono">{dc.rule}</span></div>
              </>
            ) : <div className="muted">{access.isError ? "The check could not run." : "Checking…"}</div>}
          </div>
        </div>
      </Panel>

      <Panel title="Recent calls" flush={!!recent.length}>
        {recent.length ? <div className="table-scroll"><UsageTable list={recent} compact servers={[srv]} projects={projects} actorName={actorName} /></div> : <Empty title="No calls yet" text="Calls from agents appear here." />}
      </Panel>
    </div>
  );
}
