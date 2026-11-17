/**
 * Agents (spec 8.7, 10.2, 13.2). Port of legacy/js/views/agents.js against /api/v1/agents: roster, deep configuration, layered instructions with the effective preview,
 * ordered skills, model chain, autonomy, tools, MCP, staffing, budget, guardrails, per-project overrides, versions with eval-gated promotion and rollback, trust, history, create flow.
 * Edits stay in a draft (kept across tabs and screens) until Save; saving writes one audited change. A version is a snapshot of the saved configuration and is immutable.
 * Not ported, on purpose: nothing from the legacy screen is simulation; "Run suite" opens Evals, which owns suite runs.
 */
import { useEffect, useMemo } from "react";
import { fmt, type Project } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, usePolicies, useProjects } from "../api/queries";
import { ops } from "../api/ops";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Async } from "../ui/async";
import { Avatar, Btn, Chip, Empty, LockNote, Panel, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Icon } from "../ui/Icon";
import { Spark } from "../ui/charts";
import { useUI } from "../ui/overlay-context";
import { useOutcome } from "./govern/data";
import { useDraft } from "../lib/useDraft";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { DraftConflictBanner } from "../ui/DraftConflict";
import { invalidateSlices } from "../api/keys";
import { EntityHistory, pick, rerender, ui, useAgentsUi, useStations, autonomyCheck, type AgentRow, type Draft } from "./agents/kit";
import { ConfigTab, OverridesTab, type TabProps } from "./agents/Config";
import { InstructionsTab } from "./agents/Instructions";
import { SkillsTab } from "./agents/SkillsMcp";
import { VersionsTab } from "./agents/Versions";
import { TrustTab } from "./agents/Trust";
import { CreateAgent } from "./agents/Create";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

function Roster({ agents }: { agents: AgentRow[] }) {
  const st = useStations();
  const select = (id: string) => {
    ui.sel = id;
    rerender();
    setTimeout(() => { const d = document.getElementById("agent-detail"); if (d && d.getBoundingClientRect().top > window.innerHeight * 0.6) d.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, 40);
  };
  return (
    <div className="table-scroll" data-keep-scroll="agents-roster">
      <table className="table ag-roster">
        <thead><tr>{["Agent", "Status", "Station", "Model chain", "Version", "Eval", "7-day success", "Spend 7d"].map((x, i) => <th key={x} scope="col" className={i >= 5 ? "num" : ""}>{x}</th>)}</tr></thead>
        <tbody>
          {agents.map((a) => {
            const below = a.threshold != null && a.evalScore < a.threshold;
            const rc = a.versions.filter((v) => v.rc).length;
            const station = st.find(a.station);
            return (
              <tr key={a.id} className={`row-link${ui.sel === a.id ? " is-selected" : ""}`} tabIndex={0} id={`ag-row-${a.id}`} aria-current={ui.sel === a.id ? "true" : undefined}
                onClick={() => select(a.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(a.id); } }}>
                <td data-label="Agent"><span className="who"><Avatar id={a.id} size="sm" /><strong>{a.name}</strong>{a.builtin ? <Chip text="built-in" cls="chip-accent" /> : null}</span></td>
                <td data-label="Status"><span className={`dot-status s-${a.status}`}>{a.status === "paused" ? "Paused" : "Active"}</span></td>
                <td data-label="Station" className="nowrap"><span>
                  <span className="mono muted">{station ? `${station.no} ` : ""}</span>{station ? station.name : "Off-belt"}
                  {a.stations.length > 1 ? <span className="muted small">{` +${a.stations.length - 1}`}</span> : null}
                </span></td>
                <td data-label="Model chain"><span><span className="mono small">{a.model}</span>{a.fallbacks.length ? <span className="muted small">{` +${a.fallbacks.length} fallback${a.fallbacks.length > 1 ? "s" : ""}`}</span> : null}</span></td>
                <td data-label="Version"><span><span className="mono">{a.version}</span>{rc ? <span className="chip ag-rc">{`${rc} candidate`}</span> : null}</span></td>
                <td data-label="Eval" className={`num mono${below ? " neg" : ""}`}><span>{below ? <Icon name="alert" className="ag-below" /> : null}{fmt.pct(a.evalScore)}</span></td>
                <td data-label="7-day success" className="num"><Spark values={a.spark} min={0.5} max={1} label={`7-day success, latest ${fmt.pct(a.spark[a.spark.length - 1] ?? 0)}`} /></td>
                <td data-label="Spend 7d" className="num mono">{fmt.money0(a.spend7d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ a, agents, projects }: { a: AgentRow; agents: AgentRow[]; projects: Project[] }) {
  const out = useOutcome();
  const policies = usePolicies().data ?? [];
  const st = useStations();
  const perm = dec(useCan("agent.edit"));
  const ro = !perm.allowed;
  const saved = pick(a);
  // The draft remembers the revision it started from and sends only the keys changed here: a colleague's change to another key is kept, to the same key is a conflict.
  const draft = useDraft<Draft>({
    scope: "agent", id: a.id, server: saved, rev: a.rev,
    save: (p, ifMatch) => {
      const patch: Record<string, unknown> = { ...p };
      if (typeof patch.name === "string") patch.name = patch.name.trim();
      return ops.saveAgent(a.id, patch, Object.keys(patch).join(", "), { ifMatch });
    },
    refresh: () => invalidateSlices(["agents"]),
  });
  const d = draft.values;
  const dirty = draft.dirty;
  useLeaveGuard(dirty);
  const autoChk = autonomyCheck(policies, projects, { station: a.station, projects: d.projects }, d.autonomy);
  const edit = (fn: () => void): void => draft.edit(() => fn());
  const save = () => {
    if (!d.name.trim()) { out({ ok: false, msg: "The agent needs a name.", status: 422 }); return; }
    if (!d.stations.length) { out({ ok: false, msg: "Pick at least one station the agent may staff.", status: 422 }); return; }
    void draft.save().then((r) => { if (r) out(r); });
  };
  const saveGuard: Decision | null = !perm.allowed ? perm : !autoChk.allowed ? { allowed: false, needs: "", reason: autoChk.reason ?? "" } : !dirty ? { allowed: false, needs: "", reason: "No changes to save." } : null;
  const toggleStatus = () => {
    const resume = a.status === "paused";
    void ops.saveAgent(a.id, { status: resume ? "active" : "paused" }, resume ? "resumed" : "paused", { ifMatch: a.rev }).then((r) => out(r, resume ? `${a.name} is active.` : `${a.name} is paused. Its stations queue work until it resumes.`));
  };
  const running = a.running ?? 0;
  const tabs = [
    { id: "config", label: "Configuration" }, { id: "instructions", label: "Instructions" }, { id: "skills", label: "Skills and MCP", count: d.skills.length },
    { id: "overrides", label: "Per-project", count: Object.keys(d.overrides ?? {}).length }, { id: "versions", label: "Versions", count: a.versions.length }, { id: "trust", label: "Trust" }, { id: "history", label: "History" },
  ];
  const tp: TabProps = { a, d, ro, perm, projects, policies, edit };
  const body = ui.tab === "instructions" ? <InstructionsTab {...tp} />
    : ui.tab === "skills" ? <SkillsTab {...tp} />
    : ui.tab === "overrides" ? <OverridesTab {...tp} />
    : ui.tab === "versions" ? <VersionsTab a={a} dirty={dirty} perm={perm} />
    : ui.tab === "trust" ? <TrustTab a={a} projects={projects} />
    : ui.tab === "history" ? <div className="ag-hist"><EntityHistory type="agent" id={a.id} limit={40} /></div>
    : <ConfigTab {...tp} />;
  const showSave = ["config", "instructions", "skills", "overrides"].includes(ui.tab);
  void agents;
  return (
    <section className="agent-detail panel" id="agent-detail" aria-label={`${a.name} configuration`}>
      <div className="ad-head">
        <Avatar id={a.id} size="lg" />
        <div className="ad-main">
          <div className="kicker">{`Agent · ${st.label(a.station, projects)}${a.builtin ? " · built-in" : ""}`}</div>
          <h2 className="ad-title">{a.name}</h2>
          <div className="ad-meta mono">{`${a.version} · ${a.model} · ${running} work order${running === 1 ? "" : "s"} now · ${a.suite ? `${a.suite} ${fmt.pct(a.evalScore)}` : ""}`}</div>
        </div>
        <div className="ad-tools">
          <span className={`dot-status s-${a.status}`}>{a.status === "paused" ? "Paused" : "Active"}</span>
          <Btn label={a.status === "paused" ? "Resume agent" : "Pause agent"} small icon={a.status === "paused" ? "play" : "pause"} id="ag-pause" guard={perm} onClick={toggleStatus} />
        </div>
      </div>
      <LockNote decision={perm} what="Agent configuration" />
      <Tabs idPrefix="ag-tab" items={tabs} active={ui.tab} onChange={(t) => { ui.tab = t; rerender(); }} />
      {body}
      {showSave ? <DraftConflictBanner id="ag-conflict" conflict={draft.conflict} onKeepMine={draft.keepMine} onDiscard={draft.discard} /> : null}
      {showSave ? (
        <div className={`savebar${dirty ? " is-dirty" : ""}`} id="ag-savebar">
          <span className="muted small savebar-text">Edits stay in a draft while you switch tabs or screens. Saving writes one audited change.</span>
          <Btn label="Discard" id="ag-discard" guard={!perm.allowed ? perm : null} onClick={draft.discard} />
          <Btn label="Save agent" kind="primary" id="ag-save" guard={saveGuard} onClick={save} />
        </div>
      ) : null}
    </section>
  );
}

export default function AgentsView() {
  useAgentsUi();
  const ui_ = useUI();
  const prefs = usePrefs();
  const q = useAgents();
  const agents = useMemo(() => (q.data ?? []) as unknown as AgentRow[], [q.data]);
  const projects = (useProjects().data ?? []) as Project[];
  const policies = usePolicies().data ?? [];
  const perm = dec(useCan("agent.edit"));

  // Another screen asked for an agent (prefs.agent): select it once.
  useEffect(() => {
    if (prefs.agent && agents.some((a) => a.id === prefs.agent)) {
      if (ui.sel !== prefs.agent) { ui.sel = prefs.agent; rerender(); }
      updatePrefs({ agent: null });
    }
  }, [prefs.agent, agents]);

  const sub = "Who staffs each station, on which model, with which instructions, skills and permissions.";
  const create = <Btn label="Create agent" kind="primary" icon="plus" id="agent-create" guard={perm} onClick={() => ui_.open((close) => <CreateAgent agents={agents} projects={projects} policies={policies} perm={perm} close={close} />)} />;
  if (q.data === undefined) {
    return (
      <div className="view view-agents">
        <ViewHead title="Agents" sub={sub} actions={q.isError ? create : undefined} />
        <Async query={q} what="agents" id="agents">{() => null}</Async>
      </div>
    );
  }
  if (!agents.length) {
    return (
      <div className="view view-agents">
        <ViewHead title="Agents" sub={sub} actions={create} />
        <Empty title="No agents yet" text="Create the first agent." />
      </div>
    );
  }
  if (!ui.sel || !agents.some((a) => a.id === ui.sel)) ui.sel = agents[0]!.id;
  const current = agents.find((a) => a.id === ui.sel) ?? agents[0]!;
  const active = agents.filter((a) => a.status === "active").length;
  const cands = agents.reduce((n, a) => n + a.versions.filter((v) => v.rc).length, 0);
  const below = agents.filter((a) => a.threshold != null && a.evalScore < a.threshold).length;
  return (
    <div className="view view-agents">
      <ViewHead title="Agents" sub={sub}
        meta={[["Agents", String(agents.length)], ["Active", `${active} / ${agents.length}`], ["Candidates", String(cands)], ["Below threshold", String(below)], ["Spend 7d", fmt.money0(agents.reduce((t, a) => t + a.spend7d, 0))]]}
        actions={create} />
      <Panel title="Roster" flush tools={<span className="muted small">Select a row to configure</span>}><Roster agents={agents} /></Panel>
      <Detail a={current} agents={agents} projects={projects} />
    </div>
  );
}
