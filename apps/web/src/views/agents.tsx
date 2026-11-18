/**
 * Agents (spec 8.7, 10.2, 13.2) against /api/v1/agents. Two pages: the roster (`#agents`) and one agent (`#agents/<id>`) with its layered instructions, ordered skills,
 * model chain, autonomy, tools, MCP, staffing, budget, guardrails, per-project overrides, versions with eval-gated promotion and rollback, trust, history, and the create flow.
 * Edits stay in a draft (kept across tabs and screens) until Save; saving writes one audited change. A version is a snapshot of the saved configuration and is immutable.
 * "Run suite" opens Evals, which owns suite runs.
 */
import { useEffect, useMemo } from "react";
import { fmt, type Project } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, usePolicies, useProjects, useScorecards } from "../api/queries";
import { ops } from "../api/ops";
import { hashFor, navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { useCrumbTail } from "../lib/crumb";
import { Async, useCommand } from "../ui/async";
import { Avatar, Btn, Chip, FilterBar, LockNote, SearchBox, Select, Tabs, type Decision } from "../ui/primitives";
import { DataTable, type SortCol } from "../ui/DataTable";
import { Card, CrEmpty, Page, Stats } from "../ui/cr";
import { useRouteState, useDebouncedParam } from "../lib/routeState";
import { NotFoundPage } from "./NotFound";
import { useUI } from "../ui/overlay-context";
import { useOutcome } from "./govern/data";
import { evalsFocus } from "./evals/kit";
import { useDraft } from "../lib/useDraft";
import { DraftDot } from "../ui/DraftDot";
import { useLeaveGuard } from "../lib/useLeaveGuard";
import { DraftConflictBanner } from "../ui/DraftConflict";
import { invalidateSlices } from "../api/keys";
import { EntityHistory, pick, ui, useAgentsUi, useStations, autonomyCheck, nextVersion, type AgentRow, type Draft } from "./agents/kit";
import { ConfigTab, OverridesTab, type TabProps } from "./agents/Config";
import { InstructionsTab } from "./agents/Instructions";
import { SkillsTab } from "./agents/SkillsMcp";
import { VersionsTab } from "./agents/Versions";
import { TrustStrip, TrustTab } from "./agents/Trust";
import { NewAgentDialog } from "./agents/NewAgent";
import { EvalsTab, FallbackCard, GuardrailsTab, runs30, InstructionsCard, ModelTab, OverviewTab, SkillsListTab, ToolsTab, confirmNewVersion, levelOf } from "./agents/proto";

const NA = "not available";
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** The roster (prototype `agents`): search, Station and Autonomy selects and the table. The state is in the URL (?q ?station ?lv ?sort ?dir). */
function Roster({ agents }: { agents: AgentRow[] }) {
  const st = useStations();
  const scorecards = useScorecards().data;
  const [r, setR] = useRouteState({ q: "", station: "", lv: "", sort: "name", dir: "asc" });
  const [qText, setQText] = useDebouncedParam(r.q, (v) => setR({ q: v }));
  const open = (a: AgentRow): void => navigate("agents", a.id);
  const term = qText.trim().toLowerCase();
  const rows = agents.filter((a) => (!r.station || a.station === r.station) && (!r.lv || String(levelOf(a)) === r.lv)
    && (!term || [a.name, a.id, a.model, a.station ?? ""].join(" ").toLowerCase().includes(term)));
  const any = !!(r.q || r.station || r.lv);
  const runs = (a: AgentRow): number | null => runs30(scorecards?.[a.id]);
  const cols: SortCol<AgentRow>[] = [
    { key: "name", label: "Agent", sort: (a) => a.name.toLowerCase(), render: (a) => (
      <span className="row nowrap">
        <Avatar id={a.id} size="sm" />
        <a className="rl ell" href={hashFor("agents", a.id)} title={a.id} onClick={(e) => { e.preventDefault(); open(a); }}>{a.name}</a><DraftDot scope="agent" id={a.id} />{a.builtin ? <Chip text="built-in" /> : null}
      </span>
    ) },
    { key: "station", label: "Station", sort: (a) => st.find(a.station)?.no ?? "~", render: (a) => {
      const s = st.find(a.station);
      return s ? <span className="nowrap">{s.name}</span> : <span className="dim">{"\u2014"}</span>;
    } },
    { key: "model", label: "Model", sort: true, render: (a) => <span className="mono ell">{a.model.replace("claude-", "")}</span> },
    { key: "autonomy", label: "Autonomy", sort: (a) => levelOf(a), render: (a) => <span className="lvl" style={{ "--l": levelOf(a), cursor: "default" } as React.CSSProperties}>{`L${levelOf(a)}`}</span> },
    { key: "version", label: "Version", sort: true, render: (a) => <span className="mono">{a.version}</span> },
    { key: "evalScore", label: "Eval", sort: true, align: "end", render: (a) => Number.isFinite(a.evalScore) ? <span className="mono">{a.evalScore.toFixed(2)}</span> : <span className="dim">{"\u2014"}</span> },
    { key: "runs", label: "Runs 30d", sort: (a) => runs(a) ?? -1, align: "end", render: (a) => { const n = runs(a); return n == null ? <span className="dim">{NA}</span> : <span className="mono">{n}</span>; } },
    { key: "status", label: "Status", sort: (a) => (a.status === "paused" ? "paused" : (a.running ?? 0) > 0 ? "busy" : "idle"), render: (a) => a.status === "paused" ? <Chip text="Paused" cls="idle" /> : (a.running ?? 0) > 0 ? <Chip text="Busy" cls="info" /> : <Chip text="Idle" cls="idle" /> },
  ];
  const clear = <Btn label="Clear" small kind="ghost" id="ag-clear" onClick={() => { setQText(""); setR({ q: "", station: "", lv: "" }); }} />;
  return (
    <>
      <FilterBar label="Filter agents" count={`${rows.length} of ${agents.length}`} actions={any ? clear : undefined}>
        <SearchBox id="ag-search" value={qText} onChange={setQText} placeholder="Search agents" />
        <Select id="ag-f-station" aria-label="Station" value={r.station} onChange={(v) => setR({ station: v })} options={[{ value: "", label: "Station: all" }, ...st.all.map((s) => ({ value: s.id, label: s.name }))]} />
        <Select id="ag-f-lv" aria-label="Autonomy" value={r.lv} onChange={(v) => setR({ lv: v })} options={[{ value: "", label: "Autonomy: all" }, ...[0, 1, 2, 3, 4].map((l) => ({ value: String(l), label: `L${l}` }))]} />
      </FilterBar>
      <DataTable id="ag-roster" caption="Agents" columns={cols} rows={rows} rowKey={(a) => a.id} rowId={(a) => `ag-row-${a.id}`} onRow={open} pageSize={12} pager
        sort={{ key: r.sort, dir: r.dir === "desc" ? -1 : 1 }} onSort={(x) => setR({ sort: x.key, dir: x.dir === -1 ? "desc" : "asc" })}
        empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: <Btn label="Clear filters" id="ag-empty-clear" onClick={() => { setQText(""); setR({ q: "", station: "", lv: "" }); }} /> }} />
    </>
  );
}

const TAB_IDS = ["overview", "instructions", "tools", "model", "skills", "guardrails", "evals"] as const;
/** Older links and other screens name the former tabs; each now lives inside one of the seven prototype tabs. */
const TAB_ALIAS: Record<string, string> = { settings: "model", overrides: "model", versions: "instructions", trust: "guardrails", history: "guardrails" };
const SAVE_TABS: readonly string[] = ["instructions", "tools", "model", "skills", "guardrails"];

function Detail({ a, projects }: { a: AgentRow; projects: Project[] }) {
  const ui_ = useUI();
  const out = useOutcome();
  const [route, setRoute] = useRouteState({ tab: "overview" });
  const want = TAB_ALIAS[route.tab] ?? route.tab;
  const tab = (TAB_IDS as readonly string[]).includes(want) ? want : "overview";
  const setTab = (t: string): void => setRoute({ tab: t });
  // Another screen asked for a tab (agentsSelect): apply it once the route has settled.
  useEffect(() => {
    if (!ui.want) return undefined;
    const want = ui.want;
    ui.want = "";
    const t = setTimeout(() => setRoute({ tab: want }), 0);
    return () => clearTimeout(t);
  }, [a.id, setRoute]);
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
  const saveGuard: Decision | null = !perm.allowed ? perm : draft.saving || draft.syncing ? { allowed: false, needs: "", reason: "Saving\u2026" } : !autoChk.allowed ? { allowed: false, needs: "", reason: autoChk.reason ?? "" } : !dirty ? { allowed: false, needs: "", reason: "No changes to save." } : null;
  const toggleStatus = () => {
    const resume = a.status === "paused";
    void statusCmd.run(resume).then((r) => { if (r?.ok) ui_.toast(resume ? `${a.name} is active.` : `${a.name} is paused. Its stations queue work until it resumes.`, "ok"); });
  };
  // "Save as new version": the working copy is saved first (one audited change), then a candidate snapshots it. Promotion stays a separate step on Versions.
  const saveVersion = () => {
    if ((d.instructions ?? "").trim().length < 40) { ui_.toast("Instructions are too short.", "warn"); return; }
    if ((d.instructions ?? "") === (a.instructions ?? "") && !dirty) { ui_.toast("No changes to save. Edit the instructions first.", "warn"); return; }
    confirmNewVersion(ui_, a, () => {
      void (async () => {
        let rev = a.rev;
        if (dirty) {
          const r = await draft.save();
          if (r && !r.ok) { out(r); return; }
          if (r && r.ok && typeof (r as { rev?: number }).rev === "number") rev = (r as { rev?: number }).rev as number;
        }
        const label = nextVersion(a);
        const r2 = await ops.newAgentVersion(a.id, label, "Saved from the Instructions tab", rev === a.rev ? { ifMatch: a.rev } : undefined);
        out(r2);
        if (r2.ok) ui_.toast(`${a.name} ${label} saved. The eval suite runs before it can go live.`, "ok");
      })();
    });
  };
  const running = a.running ?? 0;
  const paused = a.status === "paused";
  const station = st.find(a.station);
  const tabs = [
    { id: "overview", label: "Overview" }, { id: "instructions", label: "Instructions" }, { id: "tools", label: "Tools" }, { id: "model", label: "Model and budget" },
    { id: "skills", label: "Skills" }, { id: "guardrails", label: "Guardrails" }, { id: "evals", label: "Evals" },
  ];
  const tp: TabProps = { a, d, ro, perm, projects, policies, edit };
  const body = tab === "instructions" ? <><InstructionsCard a={a} d={d} ro={ro} edit={edit} onSaveVersion={saveVersion} saving={draft.saving || draft.syncing} /><More label="Layers and versions" id="ag-more-instr"><InstructionsTab {...tp} /><VersionsTab a={a} dirty={dirty} perm={perm} /></More></>
    : tab === "tools" ? <ToolsTab {...tp} />
    : tab === "model" ? <ModelTab {...tp} />
    : tab === "skills" ? <><SkillsListTab {...tp} /><More label="Skill pins and MCP servers" id="ag-more-skills"><SkillsTab {...tp} /></More></>
    : tab === "guardrails" ? <>
        <GuardrailsTab {...tp} />
        <More label="More guardrails, status, trust and history" id="ag-more-guard">
        <FallbackCard {...tp} /><ConfigTab {...tp} /><OverridesTab {...tp} />
        <Card title="Agent status" hint={paused ? "Paused: its stations queue work until it resumes." : "Pause it to stop new work reaching this agent."}>
          <Btn label={paused ? "Resume agent" : "Pause agent"} icon={paused ? "play" : "pause"} id="ag-pause" guard={perm} disabledReason={statusCmd.wait("Saving\u2026")} onClick={toggleStatus} />
        </Card>
        <TrustStrip a={a} projects={projects} /><TrustTab a={a} projects={projects} />
        <div className="ag-hist"><EntityHistory type="agent" id={a.id} limit={40} /></div>
        </More>
      </>
    : tab === "evals" ? <><EvalsTab a={a} /><Btn label="Open the eval suite" id="ag-evals" onClick={() => { evalsFocus({ agent: a.id, suite: a.suite }); navigate("evals"); }} /></>
    : <OverviewTab {...tp} onTab={setTab} />;
  const showSave = SAVE_TABS.includes(tab);
  const showBar = showSave && (dirty || draft.saving || !!draft.conflict);
  return (
    <Page id="agent-detail" eyebrow="Workforce · Agent" title={a.name} cls="agent-detail"
      sub={`${station ? `${station.name} station \u00b7 ` : ""}${a.model}${running ? ` \u00b7 ${running} work order${running === 1 ? "" : "s"} now` : ""}${paused ? " \u00b7 paused" : ""}`}
      acts={<>
        <Btn label="All agents" id="ag-back-link" onClick={() => navigate("agents")} />
        <Btn label="Talk" icon="chat" id="ag-talk" onClick={() => navigate("conversations")} />
      </>}>
      <LockNote decision={perm} what="Agent configuration" />
      <Tabs idPrefix="ag-tab" items={tabs} active={tab} onChange={setTab} />
      <div className="ag-body">{body}</div>
      {showSave ? <DraftConflictBanner id="ag-conflict" conflict={draft.conflict} onKeepMine={draft.keepMine} onDiscard={draft.discard} /> : null}
      {showBar ? (
        <div className={`savebar${dirty ? " is-dirty" : ""}`} id="ag-savebar">
          <span className="muted small savebar-text">Edits stay in a draft while you switch tabs or screens. Saving writes one audited change.</span>
          <Btn label="Discard" id="ag-discard" guard={!perm.allowed ? perm : null} onClick={draft.discard} />
          <Btn label="Save agent" kind="primary" id="ag-save" guard={saveGuard} onClick={save} />
        </div>
      ) : null}
    </Page>
  );
}

/** Working features beyond the prototype's card stay one click away instead of stacking under it. */
function More({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <details className="ag-more" id={id} style={{ marginTop: 12 }}><summary className="muted" style={{ cursor: "pointer", padding: "6px 0" }}>{label}</summary><div className="stack" style={{ marginTop: 8 }}>{children}</div></details>;
}

const SUB = "One agent per station. Each has instructions, tools, a model, a budget and an autonomy level people granted.";

export default function AgentsView() {
  useAgentsUi();
  const ui_ = useUI();
  const prefs = usePrefs();
  const route = useHash();
  const q = useAgents();
  const agents = useMemo(() => (q.data ?? []) as unknown as AgentRow[], [q.data]);
  const projects = (useProjects().data ?? []) as Project[];
  const scorecards = useScorecards().data;
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

  const create = <Btn label="New agent" kind="primary" icon="plus" id="agent-create" guard={perm} onClick={() => ui_.open((close) => <NewAgentDialog agents={agents} perm={perm} close={close} />)} />;
  const head = (children: React.ReactNode) => <Page eyebrow="Workforce" title="Agents" sub={SUB} acts={create} cls="view-agents">{children}</Page>;

  if (q.data === undefined) return head(<Async query={q} what="agents" id="agents">{() => null}</Async>);
  if (wanted) {
    const current = agents.find((a) => a.id === wanted);
    if (!current) return <NotFoundPage what="agent" />;
    ui.sel = current.id;
    return <Detail a={current} projects={projects} />;
  }
  if (!agents.length) return head(<div className="card"><CrEmpty title="Nothing here yet" text="Create the first agent." action={<Btn label="New agent" kind="primary" icon="plus" id="agents-empty-new" guard={perm} onClick={() => ui_.open((close) => <NewAgentDialog agents={agents} perm={perm} close={close} />)} />} /></div>);
  const cards = agents.map((a) => scorecards?.[a.id]).filter((x): x is NonNullable<typeof x> => !!x);
  const scored = agents.filter((a) => Number.isFinite(a.evalScore));
  const avgEval = scored.length ? scored.reduce((t, a) => t + a.evalScore, 0) / scored.length : null;
  const runs = cards.some((c) => runs30(c) != null) ? cards.reduce((t, c) => t + (runs30(c) ?? 0), 0) : null;
  const rework = cards.length ? cards.reduce((t, c) => t + c.rework, 0) / cards.length : null;
  return head(
    <>
      <Stats id="ag-stats" items={[
        { l: "Agents", v: agents.length, tone: "agent" },
        { l: "Avg eval score", v: avgEval == null ? NA : avgEval.toFixed(2), tone: "ok" },
        { l: "Runs, 30 days", v: runs == null ? NA : fmt.k(runs), tone: "info" },
        { l: "Avg rework", v: rework == null ? NA : `${Math.round(rework * 100)}%` },
      ]} />
      <Roster agents={agents} />
    </>,
  );
}
