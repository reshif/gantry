/**
 * Agents (spec 8.7, 10.2, 13.2) against /api/v1/agents. Two pages: the roster (`#agents`) and one agent (`#agents/<id>`) with its layered instructions, ordered skills,
 * model chain, autonomy, tools, MCP, staffing, budget, guardrails, per-project overrides, versions with eval-gated promotion and rollback, trust, history, and the create flow.
 * Edits stay in a draft (kept across tabs and screens) until Save; saving writes one audited change. A version is a snapshot of the saved configuration and is immutable.
 * "Run suite" opens Evals, which owns suite runs.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fmt, type Project } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, usePolicies, useProjects } from "../api/queries";
import { ops } from "../api/ops";
import { hashFor, navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { useCrumbTail } from "../lib/crumb";
import { Async, useCommand } from "../ui/async";
import { Avatar, Btn, Chip, Empty, FilterBar, LockNote, SearchBox, Select, Stat, StatRow, Status, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { DataTable, type SortCol } from "../ui/SortTable";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { useOutcome } from "./govern/data";
import { evalsFocus } from "./evals/kit";
import { useDraft } from "../lib/useDraft";
import { DraftDot } from "../ui/DraftDot";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { DraftConflictBanner } from "../ui/DraftConflict";
import { invalidateSlices } from "../api/keys";
import { EntityHistory, pick, rerender, ui, useAgentsUi, useStations, autonomyCheck, type AgentRow, type Draft } from "./agents/kit";
import { ConfigTab, OverridesTab, type TabProps } from "./agents/Config";
import { InstructionsTab } from "./agents/Instructions";
import { SkillsTab } from "./agents/SkillsMcp";
import { VersionsTab } from "./agents/Versions";
import { TrustStrip, TrustTab } from "./agents/Trust";
import { CreateAgent } from "./agents/Create";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

type ListTab = "all" | "station" | "candidate" | "below" | "paused";
const isBelow = (a: AgentRow): boolean => a.threshold != null && a.evalScore < a.threshold;
const candidates = (a: AgentRow): number => a.versions.filter((v) => v.rc).length;
const LIST_TABS: Array<{ id: ListTab; label: string; test: (a: AgentRow) => boolean }> = [
  { id: "all", label: "All", test: () => true },
  { id: "station", label: "Station agents", test: (a) => !!a.station },
  { id: "candidate", label: "Has candidate", test: (a) => candidates(a) > 0 },
  { id: "below", label: "Below threshold", test: isBelow },
  { id: "paused", label: "Paused", test: (a) => a.status === "paused" },
];

/** The roster's tab, search and filters live outside the component so they survive opening an agent and coming back. */
const roster = { tab: "all" as ListTab, q: "", station: "", status: "" };
const rosterListeners = new Set<() => void>();
let rosterSnap = { ...roster };
const setRoster = (p: Partial<typeof roster>): void => { Object.assign(roster, p); rosterSnap = { ...roster }; rosterListeners.forEach((l) => l()); };
const useRosterState = () => useSyncExternalStore((l) => (rosterListeners.add(l), () => rosterListeners.delete(l)), () => rosterSnap);

/** The roster: view tabs with counts, a filter bar and one table. A row opens that agent's own page. */
function Roster({ agents }: { agents: AgentRow[] }) {
  const st = useStations();
  const { tab, q, station, status } = useRosterState();
  const setTab = (v: ListTab): void => setRoster({ tab: v });
  const setQ = (v: string): void => setRoster({ q: v });
  const setStation = (v: string): void => setRoster({ station: v });
  const setStatus = (v: string): void => setRoster({ status: v });
  const open = (a: AgentRow): void => navigate("agents", a.id);
  const term = q.trim().toLowerCase();
  const inTab = LIST_TABS.find((t) => t.id === tab)!.test;
  const rows = agents.filter((a) => inTab(a)
    && (!station || a.station === station || a.stations.includes(station))
    && (!status || a.status === status)
    && (!term || `${a.name} ${a.id} ${a.model}`.toLowerCase().includes(term)));
  const lvl = (a: AgentRow): number => (a.autonomy === "auto" ? 3 : a.autonomy === "gate" ? 2 : 1);
  const cols: SortCol<AgentRow>[] = [
    { key: "name", label: "Agent", sort: (a) => a.name.toLowerCase(), render: (a) => (
      <span className="row nowrap">
        <Avatar id={a.id} size="sm" />
        <a className="rl ell" href={hashFor("agents", a.id)} title={a.id} onClick={(e) => { e.preventDefault(); open(a); }}>{a.name}</a><DraftDot scope="agent" id={a.id} />{a.builtin ? <Chip text="built-in" /> : null}
      </span>
    ) },
    { key: "station", label: "Station", sort: (a) => st.find(a.station)?.no ?? "~", render: (a) => {
      const s = st.find(a.station);
      return s ? <span className="nowrap">{s.name}{a.stations.length > 1 ? <span className="dim">{` +${a.stations.length - 1}`}</span> : null}</span> : <span className="dim">{"\u2014"}</span>;
    } },
    { key: "model", label: "Model", sort: true, render: (a) => <span className="mono ell">{a.model.replace("claude-", "")}{a.fallbacks.length ? <span className="dim">{` +${a.fallbacks.length}`}</span> : null}</span> },
    { key: "autonomy", label: "Autonomy", sort: (a) => lvl(a), render: (a) => <span className="lvl" style={{ "--l": lvl(a), cursor: "default" } as React.CSSProperties}>{`L${lvl(a)}`}</span> },
    { key: "version", label: "Version", render: (a) => { const rc = candidates(a); return <span><span className="mono">{a.version}</span>{rc ? <Chip text={`${rc} candidate`} cls="agent" /> : null}</span>; } },
    { key: "evalScore", label: "Eval", sort: true, align: "end", render: (a) => Number.isFinite(a.evalScore) ? <span className={`mono${isBelow(a) ? " neg" : ""}`}>{isBelow(a) ? <Icon name="alert" className="ag-below" /> : null}{a.evalScore.toFixed(2)}</span> : <span className="dim">{"\u2014"}</span> },
    { key: "spend7d", label: "Spend 7d", sort: true, align: "end", render: (a) => <span className="mono">{fmt.money0(a.spend7d)}</span> },
    { key: "status", label: "Status", sort: true, render: (a) => <Status tone={a.status === "paused" ? "neutral" : "run"}>{a.status === "paused" ? "Paused" : "Active"}</Status> },
  ];
  const stOpts = [{ value: "", label: "Station: all" }, ...st.all.map((s) => ({ value: s.id, label: `Station: ${s.name}` }))];
  return (
    <>
      <FilterBar label="Filter agents" count={`${rows.length} of ${agents.length}`}>
        <SearchBox id="ag-search" value={q} onChange={setQ} placeholder="Search agents" />
        <Select id="ag-f-station" aria-label="Station" value={station} onChange={setStation} options={stOpts} />
        <Select id="ag-view" aria-label="View" value={tab} onChange={(t) => setTab(t as ListTab)} options={LIST_TABS.map((t) => ({ value: t.id, label: `View: ${t.label} (${agents.filter(t.test).length})` }))} />
        <Select id="ag-f-status" aria-label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "Status: all" }, { value: "active", label: "Status: Active" }, { value: "paused", label: "Status: Paused" }]} />
      </FilterBar>
      <DataTable id="ag-roster" caption="Agents" columns={cols} rows={rows} rowKey={(a) => a.id} rowId={(a) => `ag-row-${a.id}`} onRow={open} pageSize={12} pager empty={{ title: "No agents match", text: "Clear a filter or the search to see more." }} />
    </>
  );
}

function Detail({ a, projects }: { a: AgentRow; projects: Project[] }) {
  const ui_ = useUI();
  const out = useOutcome();
  const statusCmd = useCommand((resume: boolean) => ops.saveAgent(a.id, { status: resume ? "active" : "paused" }, resume ? "resumed" : "paused", { ifMatch: a.rev }), { ok: false });
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
  const saveGuard: Decision | null = !perm.allowed ? perm : draft.saving || draft.syncing ? { allowed: false, needs: "", reason: "Saving…" } : !autoChk.allowed ? { allowed: false, needs: "", reason: autoChk.reason ?? "" } : !dirty ? { allowed: false, needs: "", reason: "No changes to save." } : null;
  const toggleStatus = () => {
    const resume = a.status === "paused";
    void statusCmd.run(resume).then((r) => { if (r?.ok) ui_.toast(resume ? `${a.name} is active.` : `${a.name} is paused. Its stations queue work until it resumes.`, "ok"); });
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
  const paused = a.status === "paused";
  const here = st.find(a.station);
  const after = here ? st.all[st.all.indexOf(here) + 1] : undefined;
  const nextLine = !here ? "off the line" : after ? `next after this station: ${after.name}` : "last station on the line";
  return (
    <section className="agent-detail" id="agent-detail" aria-label={`${a.name} configuration`}>
      <a className="back-link" id="ag-back-link" href={hashFor("agents")} onClick={(e) => { e.preventDefault(); navigate("agents"); }}><Icon name="back" />All agents</a>
      <ViewHead
        kicker={`Agent · ${st.label(a.station, projects)}${a.builtin ? " · built-in" : ""}`}
        title={<span className="ag-title"><span>{a.name}</span><Status tone={paused ? "neutral" : "done"}>{paused ? "Paused" : "Active"}</Status></span>}
        sub={<span className="ad-meta mono">{[a.version, a.model, `${running} work order${running === 1 ? "" : "s"} now`, a.suite ? `${a.suite} ${fmt.pct(a.evalScore)}` : "", nextLine].filter(Boolean).join(" · ")}</span>}
        actions={<>
          <Btn label={paused ? "Resume agent" : "Pause agent"} icon={paused ? "play" : "pause"} id="ag-pause" guard={perm} disabledReason={statusCmd.wait("Saving…")} onClick={toggleStatus} />
          <Btn label="Evals" icon="eval" id="ag-evals" onClick={() => { evalsFocus({ agent: a.id, suite: a.suite }); navigate("evals"); }} />
        </>}
      />
      <TrustStrip a={a} projects={projects} />
      <LockNote decision={perm} what="Agent configuration" />
      <div className="panel ag-panel">
      <Tabs idPrefix="ag-tab" items={tabs} active={ui.tab} onChange={(t) => { ui.tab = t; rerender(); }} />
      <div className="ag-body">{body}</div>
      {showSave ? <DraftConflictBanner id="ag-conflict" conflict={draft.conflict} onKeepMine={draft.keepMine} onDiscard={draft.discard} /> : null}
      {showSave ? (
        <div className={`savebar${dirty ? " is-dirty" : ""}`} id="ag-savebar">
          <span className="muted small savebar-text">Edits stay in a draft while you switch tabs or screens. Saving writes one audited change.</span>
          <Btn label="Discard" id="ag-discard" guard={!perm.allowed ? perm : null} onClick={draft.discard} />
          <Btn label="Save agent" kind="primary" id="ag-save" guard={saveGuard} onClick={save} />
        </div>
      ) : null}
      </div>
    </section>
  );
}

export default function AgentsView() {
  useAgentsUi();
  const ui_ = useUI();
  const prefs = usePrefs();
  const route = useHash();
  const q = useAgents();
  const agents = useMemo(() => (q.data ?? []) as unknown as AgentRow[], [q.data]);
  const projects = (useProjects().data ?? []) as Project[];
  const policies = usePolicies().data ?? [];
  const perm = dec(useCan("agent.edit"));
  const wanted = route.id === "agents" ? route.param : null;
  useCrumbTail(wanted ? agents.find((a) => a.id === wanted)?.name : null);

  // Another screen asked for an agent (prefs.agent): open its page once.
  useEffect(() => {
    if (prefs.agent && agents.some((a) => a.id === prefs.agent)) {
      const id = prefs.agent;
      updatePrefs({ agent: null });
      navigate("agents", id);
    }
  }, [prefs.agent, agents]);

  const sub = "Who staffs each station, on which model, with which instructions, skills and permissions. Every change is a draft, then a version, then a promotion.";
  const create = <Btn label="Create agent" kind="primary" icon="plus" id="agent-create" guard={perm} onClick={() => ui_.open((close) => <CreateAgent agents={agents} projects={projects} policies={policies} perm={perm} close={close} />)} />;

  if (q.data === undefined) {
    return (
      <div className="view view-agents">
        <ViewHead kicker="Workforce" title="Agents" sub={sub} actions={q.isError ? create : undefined} />
        <Async query={q} what="agents" id="agents">{() => null}</Async>
      </div>
    );
  }
  if (!agents.length) {
    return (
      <div className="view view-agents">
        <ViewHead kicker="Workforce" title="Agents" sub={sub} actions={create} />
        <Empty title="No agents yet" text="Create the first agent." />
      </div>
    );
  }
  if (wanted) {
    const current = agents.find((a) => a.id === wanted);
    if (!current) {
      return (
        <div className="view view-agents">
          <ViewHead title="Agent not found" sub="This agent does not exist, or it was removed." />
          <Empty title="No agent with that id" text="Pick one from the roster." action={<Btn label="Back to agents" icon="back" id="ag-back" onClick={() => navigate("agents")} />} />
        </div>
      );
    }
    ui.sel = current.id;
    return <div className="view view-agents"><Detail a={current} projects={projects} /></div>;
  }
  const active = agents.filter((a) => a.status === "active").length;
  const cands = agents.reduce((n, a) => n + candidates(a), 0);
  const below = agents.filter(isBelow).length;
  return (
    <div className="view view-agents">
      <ViewHead kicker="Workforce" title="Agents" sub={sub} actions={create} />
      <StatRow id="ag-stats">
        <Stat label="Agents" value={String(agents.length)} />
        <Stat label="Active" value={`${active} / ${agents.length}`} tone="done" />
        <Stat label="Candidates" value={String(cands)} tone={cands ? "wait" : undefined} />
        <Stat label="Below threshold" value={String(below)} tone={below ? "block" : undefined} />
        <Stat label="Spend, 7 days" value={fmt.money0(agents.reduce((t, a) => t + a.spend7d, 0))} />
      </StatRow>
      <Roster agents={agents} />
    </div>
  );
}
