/** The selected server: settings and tools, scope, the access check and recent calls (legacy detail()). */
import { useState } from "react";
import { flowOf, classesOf, type Agent, type Catalog, type McpServer, type McpUsage, type Project, type Repo } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useMcpAccessCheck, type McpAccessDecision } from "../../api/queries";
import { Btn, Empty, Field, LockNote, Panel, Select, Tabs, ViewHead, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { useUI } from "../../ui/overlay-context";
import { REAPPROVAL_WHY, SENS, classesFor, dec, draftOf, mcpState, projectsIn, stationsFor, type ScopeDraft } from "./kit";
import { SwitchRow, healthTone, ago, useTab } from "../connect/kit";
import { hashFor, navigate } from "../../lib/router";
import { useCrumbTail } from "../../lib/crumb";

const WRITE_ALWAYS: Decision = { allowed: false, reason: "Write tools always need a station pre-authorisation for the work order and attempt. There is no switch to turn it off. Only a Factory Admin can grant it." };

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

interface Props { srv: McpServer | null; cat: Catalog | null; projects: Project[]; agents: Agent[]; repos: Repo[]; calls: McpUsage[]; actorName: (id: string) => string }

const TAB_IDS = ["overview", "tools", "scope", "check", "calls"];

/** One server at #mcp/<id>: breadcrumb, name, URL, and the Overview, Tools, Scope, Access check and Recent calls tabs (prototype mcpDetail). */
export function Detail({ srv, cat, projects, agents, repos, calls, actorName }: Props) {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const ro = !perm.allowed;
  const [tab, setTab] = useTab(TAB_IDS);
  useCrumbTail(srv?.name);
  const v = srv?.version !== undefined ? { ifMatch: srv.version } : undefined;
  const show = (r: { ok: boolean; msg: string }, okMsg?: string): void => ui.toast(r.ok ? okMsg ?? r.msg : r.msg, r.ok ? "ok" : "error");

  // ---- scope draft
  const [draft, setDraft] = useState<ScopeDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const base = srv ? draftOf(srv) : null;
  const d = draft ?? base;

  // ---- access check
  const [chk, setChk] = useState({ agent: "", project: "", repo: "", station: "", cls: "", tool: "" });
  const [ran, setRan] = useState<McpAccessDecision | "error" | null>(null);
  const agent = chk.agent && agents.some((a) => a.id === chk.agent) ? chk.agent : (srv && srv.agents !== "all" ? srv.agents[0] : undefined) ?? agents[0]?.id ?? "";
  const projectId = chk.project && projects.some((p) => p.id === chk.project) ? chk.project : projects.find((p) => p.id === "payments")?.id ?? projects[0]?.id ?? "";
  const chkP = projects.find((p) => p.id === projectId);
  const chkStations = cat && chkP ? flowOf(cat, chkP).active : [];
  const chkClasses = cat && chkP ? classesOf(cat, chkP) : [];
  const tool = srv?.tools.some((t) => t.name === chk.tool) ? chk.tool : srv?.tools[0]?.name ?? "";
  const station = chkStations.some((s) => s.id === chk.station) ? chk.station : chkStations[0]?.id ?? "";
  const repoChoices = repos.filter((r) => r.project === projectId);
  const repo = repoChoices.some((r) => r.id === chk.repo) ? chk.repo : "";
  const cls = chkClasses.some((x) => x.id === chk.cls) ? chk.cls : "";
  const access = useMcpAccessCheck({ server: srv?.id ?? "", tool, agent, project: projectId, ...(repo ? { repo } : {}), station, ...(cls ? { cls } : {}) }, false);
  const agentName = actorName(agent).replace(" (agent)", "");
  const run = async (): Promise<void> => { const r = await access.refetch(); setRan(r.data ?? "error"); };

  if (!srv || !d || !base) {
    return (
      <div className="view cx mcp-view">
        <ViewHead title="MCP server" kicker="All lines" />
        <Panel><Empty title="Nothing to show" text="That server does not exist." action={<Btn label="Work orders" id="mcp-back" onClick={() => navigate("work-orders")} />} /></Panel>
      </div>
    );
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  const live = projects.filter((p) => p.status !== "archived");
  const scopeRepos = repos.filter((r) => d.projects === "all" || d.projects.includes(r.project));
  const inScope = projectsIn(projects, d.projects);
    const enabledIn = projects.filter((p) => (p.mcp ?? []).includes(srv.id));
  const mine = calls.filter((u) => u.server === srv.id);
  const changed = srv.tools.filter((t) => t.changed);
  const names = (ids: "all" | string[] | null | undefined, all: string, f: (id: string) => string): string => (ids === "all" || ids == null ? all : ids.length ? ids.map(f).join(", ") : "\u2014");

  const saveScope = async () => {
    const patch: Record<string, unknown> = JSON.parse(JSON.stringify(d));
    if (Array.isArray(patch.stations) && cat) { const ok = stationsFor(cat, inScope).map((x) => x.id); patch.stations = (patch.stations as string[]).filter((id) => ok.includes(id)); }
    if (Array.isArray(patch.classes) && cat) { const ok = classesFor(cat, inScope).map((x) => x.id); patch.classes = (patch.classes as string[]).filter((id) => ok.includes(id)); }
    if (Array.isArray(patch.repos)) patch.repos = (patch.repos as string[]).filter((id) => { const r = repos.find((x) => x.id === id); return !!r && (d.projects === "all" || d.projects.includes(r.project)); });
    const r = await ops.updateMCP(srv.id, patch, v);
    show(r, `Scope saved for ${srv.name}.`);
    if (r.ok) { setDraft(null); setEditing(false); }
  };

  const remove = () => {
    const listing = agents.filter((a) => (a.mcp ?? []).includes(srv.id));
    ui.open((close) => (
      <Dialog title={`Remove ${srv.name}?`} kicker="MCP registry" onClose={close} actions={[
        { label: "Cancel" },
        { label: "Remove server", kind: "danger", id: "mcp-remove-go", guard: perm, onClick: async () => { const r = await ops.removeMCP(srv.id, v); show(r); if (r.ok) { navigate("mcp"); close(); } } },
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

  const st = mcpState(srv);
  const tabs = [{ id: "overview", label: "Overview" }, { id: "tools", label: "Tools", count: srv.tools.length }, { id: "scope", label: "Scope" }, { id: "check", label: "Access check" }, { id: "calls", label: "Recent calls" }];
  const verdict = ran && ran !== "error" ? (ran.allowed ? (ran.gated ? { t: "Allowed, with approval", tone: "warn" } : { t: "Allowed", tone: "ok" }) : { t: "Denied", tone: "bad" }) : null;

  const editDialog = editing ? (
    <Dialog title={`Edit ${srv.name}`} kicker="MCP registry" wide onClose={() => { setEditing(false); setDraft(null); }} actions={[
      ...(dirty ? [{ label: "Revert", id: "mcp-sc-revert", onClick: () => setDraft(null) }] : []),
      { label: "Done" },
      { label: "Save scope", kind: "primary" as const, id: "mcp-sc-save", guard: perm.allowed && !dirty ? { allowed: false, reason: "No changes to save." } : perm, onClick: () => void saveScope() },
    ]} body={(
      <div className="form-grid">

                <fieldset className="mcp-scope" id="mcp-settings">
                  <legend className="field-label">Server settings</legend>
                  <Field label="Sensitivity" htmlFor="mcp-sens"><Select id="mcp-sens" options={SENS} value={srv.sensitivity} disabled={ro} onChange={(x) => void ops.updateMCP(srv.id, { sensitivity: x }, v).then((r) => show(r, `${srv.name} is now ${x}.`))} /></Field>
                  <SwitchRow id="mcp-enabled" label="Enabled" checked={srv.enabled !== false}
                    decision={ro ? perm : srv.needsReapproval ? { allowed: false, reason: `Needs re-approval. ${REAPPROVAL_WHY}` } : srv.disabledReason && srv.enabled === false ? { allowed: false, reason: "Re-approve the changed definitions to switch it back on." } : null}
                    onChange={(on) => void ops.updateMCP(srv.id, { enabled: on }, v).then((r) => show(r, on ? `${srv.name} enabled.` : `${srv.name} disabled.`))} />
                  <p className="small muted">Enabled in projects: {enabledIn.length ? enabledIn.map((p) => p.key).join(", ") : "none"}. Protocol revision {srv.protocolRevision || "not yet discovered"}, last discovery {srv.discoveredAt ? ago(srv.discoveredAt) : "never"}.</p>
                  <div className="row mcp-danger">
                    <Btn label="Check again" icon="search" id="mcp-recheck" guard={perm} onClick={() => void ops.rediscoverMCP(srv.id, v).then((r) => show(r))} />
                    <Btn label="Remove server" kind="danger" icon="x" id="mcp-remove" guard={perm} onClick={remove} />
                  </div>
                </fieldset>
                {srv.tools.length ? (
                  <fieldset className="mcp-scope" id="mcp-tool-classes">
                    <legend className="field-label">Tool classes</legend>
                    {srv.tools.map((t, i) => (
                      <label key={t.name} className="check switch-row" htmlFor={`mcp-tool-class-${i}`}>
                        <span className="mono small">{t.name}{t.hint && (t.hint === "write") !== t.write ? <span className="muted"> (server suggests {t.hint})</span> : null}</span>
                        <select id={`mcp-tool-class-${i}`} className="input mcp-class" aria-label={`Class of ${t.name}`} value={t.write ? "write" : "read"} disabled={ro}
                          onChange={(e) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, write: e.target.value === "write" }] }, v).then((r) => show(r, `${t.name} is now a ${e.target.value} tool.`))}>
                          <option value="read">read</option>
                          <option value="write">write</option>
                        </select>
                      </label>
                    ))}
                  </fieldset>
                ) : null}
                <p className="muted small">An agent may call this server only where every scope matches. Projects must also enable it in Project config.</p>
                <ScopeGroup k="projects" label="Projects" items={live.map((p) => ({ id: p.id, label: p.name }))} d={d} ro={ro} allowAll set={setDraft} />
                <ScopeGroup k="repos" label="Repos" items={scopeRepos.map((r) => ({ id: r.id, label: r.name, mono: true }))} d={d} ro={ro} allowAll set={setDraft} />
                <ScopeGroup k="agents" label="Agents" items={agents.map((a) => ({ id: a.id, label: a.name }))} d={d} ro={ro} allowAll={false} set={setDraft} />
                <ScopeGroup k="stations" label="Stations (from the flows of the projects in scope)" items={cat ? stationsFor(cat, inScope) : []} d={d} ro={ro} allowAll={false} set={setDraft} />
                <ScopeGroup k="classes" label="Work classes" items={cat ? classesFor(cat, inScope) : []} d={d} ro={ro} allowAll set={setDraft} />
      </div>
    )} />
  ) : null;

  return (
    <div className="view cx mcp-view mcp-detail">
      <ViewHead crumbs={[{ label: "MCP servers", href: hashFor("mcp") }, { label: srv.name }]} title={srv.name} sub={srv.url} />
      {editDialog}
      <Tabs idPrefix="mcp-dtab" items={tabs} active={tab} onChange={setTab} />
      <div id="mcp-dtab-panel" role="tabpanel" aria-labelledby={`mcp-dtab-${tab}`} className="stack">
        {tab === "tools" ? (
          <Panel title="Tools" id="mcp-tools">
            <LockNote decision={perm} what="MCP tool settings" />
            {srv.tools.length ? srv.tools.map((t, i) => (
              <SwitchRow key={t.name} id={`mcp-tool-${i}`} label={t.name} hint={t.write ? "Writes data" : "Read only"}
                checked={t.allowed} decision={perm}
                extra={t.changed ? <span className="chip bad" title="The server reports a different definition than the one approved">changed</span> : null}
                onChange={(on) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, allowed: on }] }, v).then((r) => show(r, `${t.name}${on ? " allowed" : " blocked"}`))} />
            )) : <Empty title="No tools discovered" text="Check the server again to list its tools." />}
          </Panel>
        ) : tab === "scope" ? (
          <Panel title="Who may use it" id="mcp-scope" tools={<Btn label="Edit scope" small id="mcp-sc-edit" guard={perm} onClick={() => setEditing(true)} />}>
            <dl className="kv">
              <dt>Projects</dt><dd>{names(srv.projects, "All projects", (id) => projects.find((p) => p.id === id)?.name ?? id)}</dd>
              <dt>Repos</dt><dd>{names(srv.repos, "All repos", (id) => repos.find((r) => r.id === id)?.name ?? id)}</dd>
              <dt>Stations</dt><dd>{names(srv.stations, "All stations", (id) => id)}</dd>
              <dt>Agents</dt><dd>{srv.agents === "all" ? "All agents" : srv.agents.length ? <div className="row">{srv.agents.map((a) => <a key={a} id={`mcp-agent-${a}`} href={hashFor("agents", a)}>{actorName(a).replace(" (agent)", "")}</a>)}</div> : "\u2014"}</dd>
            </dl>
          </Panel>
        ) : tab === "check" ? (
          <Panel title="Would this call be allowed?" id="mcp-check">
            <div className="form-grid">
              <div className="cols">
                <Field label="Agent" htmlFor="mcp-chk-agent"><Select id="mcp-chk-agent" options={agents.map((a) => ({ value: a.id, label: a.name }))} value={agent} onChange={(x) => { setChk({ ...chk, agent: x }); setRan(null); }} /></Field>
                <Field label="Tool" htmlFor="mcp-chk-tool"><Select id="mcp-chk-tool" options={srv.tools.map((t) => ({ value: t.name, label: t.name }))} value={tool} onChange={(x) => { setChk({ ...chk, tool: x }); setRan(null); }} /></Field>
              </div>
              <div className="row"><Btn label="Check access" kind="primary" id="mcp-chk-run" onClick={() => void run()} /></div>
              <div role="status" aria-live="polite" id="mcp-chk-result">
                {ran === "error" ? <div className="muted">The check could not run.</div> : ran && verdict ? (
                  <div className={`callout ${verdict.tone}`} title={`Deciding rule ${ran.rule}`}>
                    <b>{verdict.t}</b>
                    {ran.allowed ? `${agentName} may call ${tool}${ran.gated ? "; the write waits at a gate." : "."}` : ran.reason}
                  </div>
                ) : null}
              </div>
            </div>
          </Panel>
        ) : tab === "calls" ? (
          <Panel title="Calls" flush id="mcp-calls">
            {mine.length ? (
              <ul className="list">
                {mine.slice(0, 30).map((u, i) => (
                  <li key={u.id ?? `${u.at}-${i}`}>
                    <span className="mono grow">{u.tool}</span>
                    <span className="small">{u.agent ? actorName(u.agent).replace(" (agent)", "") : "unknown"}</span>
                    <span className={`chip ${u.outcome === "ok" ? "ok" : "warn"}`} title={u.reason || undefined}>{u.outcome}</span>
                    <span className="small muted">{ago(u.at)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No calls yet" text="Calls from agents appear here." />}
          </Panel>
        ) : (
          <Panel title="Server" id="mcp-server">
            <div className="form-grid">
              <LockNote decision={perm} what="MCP server settings" />
              {srv.needsReapproval ? (
                <div className="lock-note" role="status" id="mcp-reapproval-note">
                  <span><strong>Needs re-approval.</strong> {REAPPROVAL_WHY}</span>
                  <Btn label="Discover its tools" icon="search" id="mcp-reapproval-discover" small guard={perm} onClick={() => void ops.rediscoverMCP(srv.id, v).then((r) => show(r))} />
                  <Btn label="Review and approve" id="mcp-reapproval-approve" small kind="primary" guard={perm} onClick={approve} />
                </div>
              ) : null}
              {srv.enabled === false && !srv.needsReapproval ? (
                <div className="lock-note" role="status" id="mcp-disabled-note">
                  <span>Disabled{srv.disabledReason ? `: ${srv.disabledReason}.` : "."} Agents cannot call it.{srv.disabledReason ? " An admin has to re-approve it." : ""}</span>
                  {srv.disabledReason ? <Btn label="Review and re-approve" id="mcp-approve" small kind="primary" guard={perm} onClick={approve} /> : null}
                </div>
              ) : null}
              <dl className="kv">
                <dt>URL</dt><dd><span className="mono" title={srv.url}>{srv.url}</span></dd>
                <dt>Transport</dt><dd>{srv.transport}</dd>
                <dt>Auth</dt><dd>{srv.auth} <span className="mono">{srv.authMask}</span></dd>
                <dt>Sensitivity</dt><dd>{srv.sensitivity}</dd>
                <dt>Health</dt><dd><span className={`chip ${healthTone(st)}`}>{st}</span>{srv.healthDetail ? <div className="neg small">{srv.healthDetail}</div> : null}</dd>
                <dt>Write gate</dt><dd><SwitchRow id="mcp-writegate" label="Writes need approval" checked onChange={() => ui.toast(WRITE_ALWAYS.reason, "warn")} /></dd>
              </dl>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
