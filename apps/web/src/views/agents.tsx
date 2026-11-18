/**
 * Agents (spec 8.7, 10.2, 13.2) against /api/v1/agents. Two pages: the roster (`#agents`) and one agent (`#agents/<id>`) with its layered instructions, ordered skills,
 * model, autonomy, tools, skills and MCP, per-project overrides and versions with rollback. The model, autonomy and tool controls write at once (one audited change, toasted);
 * instructions are saved as a new version. A version is a snapshot of the saved configuration and is immutable.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fmt, type Project } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, usePolicies, useProjects } from "../api/queries";
import { createThread, useInbox } from "./workspace/api";
import { ops } from "../api/ops";
import { hashFor, navigate, useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { useRouteTab } from "../lib/routeQuery";
import { useCrumbTail } from "../lib/crumb";
import { Async, useCommand } from "../ui/async";
import { Avatar, Btn, Chip, Empty, Field, FilterBar, LockNote, Panel, SearchBox, Select, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { DataTable, type SortCol } from "../ui/SortTable";
import { Spark } from "../ui/charts";
import { useUI } from "../ui/overlay-context";
import { Dialog } from "../ui/Overlay";
import { useOutcome } from "./govern/data";
import { nextVersion, ui, useAgentsUi, useStations, type AgentRow } from "./agents/kit";
import { ConfigTab, OverridesTab, type TabProps } from "./agents/Config";
import { InstructionsTab } from "./agents/Instructions";
import { SkillsTab } from "./agents/SkillsMcp";
import { VersionsTab } from "./agents/Versions";
import "../styles/views/agents.css";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** The roster's search and filters live outside the component so they survive opening an agent and coming back. */
const roster = { q: "", station: "", status: "", autonomy: "" };
const rosterListeners = new Set<() => void>();
let rosterSnap = { ...roster };
const setRoster = (p: Partial<typeof roster>): void => { Object.assign(roster, p); rosterSnap = { ...roster }; rosterListeners.forEach((l) => l()); };
const useRosterState = () => useSyncExternalStore((l) => (rosterListeners.add(l), () => rosterListeners.delete(l)), () => rosterSnap);
/** Test hook: back to an unfiltered roster. */
export const resetRoster = (): void => setRoster({ q: "", station: "", status: "", autonomy: "" });

/** The roster: a filter bar and one flush table. A row opens that agent's own page. */
function Roster({ agents }: { agents: AgentRow[] }) {
  const st = useStations();
  const { q, station, status, autonomy } = useRosterState();
  const autonomies = [...new Set(agents.map((a) => a.autonomy))];
  const open = (a: AgentRow): void => navigate("agents", a.id);
  const term = q.trim().toLowerCase();
  const rows = agents.filter((a) => (!station || a.station === station) && (!status || a.status === status) && (!autonomy || a.autonomy === autonomy)
    && (!term || `${a.name} ${a.station ?? ""} ${a.model}`.toLowerCase().includes(term)));
  const active = !!(q || station || status || autonomy);
  const clear = (): void => resetRoster();
  const cols: SortCol<AgentRow>[] = [
    { key: "name", label: "Agent", sort: (a) => a.name.toLowerCase(), render: (a) => (
      <span className="ag-who">
        <Avatar id={a.id} size="sm" />
        <span className="ag-who-t">
          <a className="pri ag-name" href={hashFor("agents", a.id)} onClick={(e) => { e.preventDefault(); open(a); }}>{a.name}</a>
          <span className="sub">{st.find(a.station)?.name ?? "Roaming"}</span>
        </span>
      </span>
    ) },
    { key: "model", label: "Model", sort: true, render: (a) => <span className="mono small">{a.model}</span> },
    { key: "autonomy", label: "Autonomy", sort: true, render: (a) => <Chip text={a.autonomy} cls={a.autonomy === "auto" ? "info" : a.autonomy === "gate" ? "warn" : "plain"} /> },
    { key: "version", label: "Version", render: (a) => <span className="mono">v{a.version}</span> },
    { key: "evalScore", label: "Eval", sort: true, align: "end", render: (a) => <span className="num">{fmt.pct(a.evalScore)}</span> },
    { key: "spark", label: "7-day", hideSmall: true, render: (a) => <Spark line values={a.spark} w={70} label={`7-day success, latest ${fmt.pct(a.spark[a.spark.length - 1] ?? 0)}`} /> },
    { key: "spend7d", label: "Spend", sort: true, align: "end", render: (a) => <span className="num">{fmt.money0(a.spend7d)}</span> },
    { key: "status", label: "Status", render: (a) => <Chip text={a.status} cls={a.status === "active" ? "ok" : "warn"} /> },
  ];
  return (
    <Panel flush cls="ag-roster-panel">
      <FilterBar label="Filter agents" count={rows.length === agents.length ? `${rows.length} agent${rows.length === 1 ? "" : "s"}` : `${rows.length} agent${rows.length === 1 ? "" : "s"} of ${agents.length}`} actions={active ? <Btn label="Clear" small kind="ghost" id="ag-clear" onClick={clear} /> : undefined}>
        <SearchBox id="ag-search" value={q} onChange={(v) => setRoster({ q: v })} placeholder="Search…" label="Search agents" />
        <Field label="Station" htmlFor="ag-f-station"><Select id="ag-f-station" value={station} onChange={(v) => setRoster({ station: v })} options={[{ value: "", label: "All" }, ...st.all.map((s) => ({ value: s.id, label: s.name }))]} /></Field>
        <Field label="Autonomy" htmlFor="ag-f-autonomy"><Select id="ag-f-autonomy" value={autonomy} onChange={(v) => setRoster({ autonomy: v })} options={[{ value: "", label: "All" }, ...autonomies.map((x) => ({ value: x, label: x }))]} /></Field>
        <Field label="Status" htmlFor="ag-f-status"><Select id="ag-f-status" value={status} onChange={(v) => setRoster({ status: v })} options={[{ value: "", label: "All" }, { value: "active", label: "active" }, { value: "paused", label: "paused" }]} /></Field>
      </FilterBar>
      <DataTable id="ag-roster" caption="Agents" columns={cols} rows={rows} rowKey={(a) => a.id} rowId={(a) => `ag-row-${a.id}`} onRow={open} pageSize={12} pager sortSelect={false}
        empty={agents.length ? { title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn label="Clear filters" id="ag-clear-empty" onClick={clear} /> } : { title: "Nothing here yet", text: "Items will appear here when they exist." }} />
    </Panel>
  );
}

/** Talk: a side thread with this agent about one work order; the agent answers in its own voice and cannot change the work order. */
function TalkDialog({ a, close }: { a: AgentRow; close: () => void }) {
  const inbox = useInbox(false);
  const wos = (inbox.data?.items ?? []).filter((w) => w.kind === "primary" && !w.archived);
  const [wo, setWo] = useState("");
  const [err, setErr] = useState("");
  const pick = wo || wos[0]?.key || "";
  const start = async (): Promise<void> => {
    const item = wos.find((w) => w.key === pick);
    if (!item?.scope.id) { setErr("Pick a work order to talk about."); return; }
    const r = await createThread({ scope: { kind: "work_order", id: item.scope.id }, agent: a.id, visibility: "private" });
    if (!r.ok) { setErr(r.msg); return; }
    close();
    navigate("workspace", r.id);
  };
  return (
    <Dialog title={`Talk to ${a.name}`} kicker="Agents" onClose={close}
      sub="A side thread about one work order. The agent reads its documents, questions and sources and answers in its own voice."
      actions={[{ label: "Cancel" }, { label: "Start", kind: "primary", submit: true, id: "ag-talk-ok", onClick: () => void start() }]}
      body={(
        <div className="form-grid">
          <Field label="About work order" htmlFor="ag-talk-wo" hint={wos.length ? undefined : "No work order has a thread yet."}>
            <Select id="ag-talk-wo" value={pick} onChange={setWo} options={wos.map((w) => ({ value: w.key, label: `${w.scope.id} · ${w.title.slice(0, 60)}` }))} />
          </Field>
          <div className="form-err" role="alert">{err}</div>
        </div>
      )} />
  );
}

function Detail({ a, projects }: { a: AgentRow; projects: Project[] }) {
  const ui_ = useUI();
  const out = useOutcome();
  const policies = usePolicies().data ?? [];
  const st = useStations();
  const perm = dec(useCan("agent.edit"));
  const ro = !perm.allowed;
  const write = useCommand((patch: Record<string, unknown>, note: string) => ops.saveAgent(a.id, patch, note, { ifMatch: a.rev }), { ok: false });
  /** One change, written at once; the toast says what changed. */
  const apply = (patch: Record<string, unknown>, msg: string): void => {
    void write.run(patch, Object.keys(patch).join(", ")).then((r) => { if (r?.ok) ui_.toast(msg, "ok"); });
  };
  /** "Save as new version": the edited text is saved, then a version snapshots it; it goes live after its suite passes. */
  const saveAsVersion = (text: string): void => {
    if (text.trim().length < 20) { ui_.toast("Instructions need at least 20 characters", "error"); return; }
    void (async () => {
      if (text !== a.instructions) {
        const r = await ops.saveAgent(a.id, { instructions: text }, "instructions", { ifMatch: a.rev });
        if (!r.ok) { out(r); return; }
      }
      const label = nextVersion(a);
      const r2 = await ops.newAgentVersion(a.id, label, "Edited in web");
      if (r2.ok) ui_.toast(`Saved v${label}`, "ok"); else out(r2);
    })();
  };
  const paused = a.status === "paused";
  const [tab, setTab] = useRouteTab(["config", "instr", "skills", "proj", "versions"], "config");
  const tabs = [
    { id: "config", label: "Configuration" }, { id: "instr", label: "Instructions" }, { id: "skills", label: "Skills and MCP", count: a.skills.length + a.mcp.length },
    { id: "proj", label: "Per-project", count: Object.keys(a.overrides ?? {}).length || undefined }, { id: "versions", label: "Versions", count: a.versions.length },
  ];
  const tp: TabProps = { a, ro, perm, projects, policies, apply, saveAsVersion };
  const body = tab === "instr" ? <InstructionsTab key={`${a.id}-${a.rev}`} {...tp} />
    : tab === "skills" ? <SkillsTab {...tp} />
    : tab === "proj" ? <OverridesTab {...tp} />
    : tab === "versions" ? <VersionsTab a={a} perm={perm} />
    : <ConfigTab {...tp} />;
  const stn = st.find(a.station);
  return (
    <section className="agent-detail" id="agent-detail" aria-label={`${a.name} configuration`}>
      <ViewHead
        crumbs={[{ label: "Agents", href: hashFor("agents"), onClick: () => navigate("agents") }, { label: a.name }]}
        title={a.name}
        sub={stn?.purpose ?? "Roaming agent"}
        actions={<><Btn label="Talk" icon="chat" id="ag-talk" onClick={() => ui_.open((close) => <TalkDialog a={a} close={close} />)} /><Btn label={paused ? "Resume agent" : "Pause agent"} icon={paused ? "play" : "pause"} id="ag-pause" guard={perm} disabledReason={write.wait("Saving…")} onClick={() => apply({ status: paused ? "active" : "paused" }, `${a.name} ${paused ? "active" : "paused"}`)} /></>}
      />
      <StatRow id="ag-detail-stats">
        <Stat label="Eval score" value={fmt.pct(a.evalScore)} sub={`suite ${a.suite}`} tone={a.evalScore > 0.9 ? "done" : "wait"} />
        <Stat label="Version" value={`v${a.version}`} sub={`${a.versions.length} releases`} />
        <Stat label="Spend, 7d" value={fmt.money0(a.spend7d)} />
        <Stat label="Autonomy" value={a.autonomy} sub="gate mode" />
      </StatRow>
      <LockNote decision={perm} what="Agent configuration" />
      <Tabs idPrefix="ag-tab" items={tabs} active={tab} onChange={setTab} />
      <div className="stack ag-body">{body}</div>
    </section>
  );
}

export default function AgentsView() {
  useAgentsUi();
  const prefs = usePrefs();
  const route = useHash();
  const q = useAgents();
  const agents = useMemo(() => (q.data ?? []) as unknown as AgentRow[], [q.data]);
  const projects = (useProjects().data ?? []) as Project[];
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

  const sub = "The workers on the line: who they are, what they may touch, and how they have performed.";

  if (q.data === undefined) {
    return (
      <div className="view view-agents">
        <ViewHead title="Agents" kicker="All lines" sub={sub} />
        <Async query={q} what="agents" id="agents">{() => null}</Async>
      </div>
    );
  }
  if (wanted) {
    const current = agents.find((a) => a.id === wanted);
    if (!current) {
      return (
        <div className="view view-agents">
          <ViewHead title="Agent" kicker="All lines" />
          <Panel><Empty title="Nothing to show" text="That agent does not exist." action={<Btn label="Work orders" id="ag-back" onClick={() => navigate("work-orders")} />} /></Panel>
        </div>
      );
    }
    ui.sel = current.id;
    return <div className="view view-agents"><Detail a={current} projects={projects} /></div>;
  }
  const active = agents.filter((a) => a.status === "active").length;
  return (
    <div className="view view-agents">
      <ViewHead title="Agents" kicker="All lines" sub={sub} actions={<><Btn label="Evals" onClick={() => navigate("evals")} /><Btn label="Trust ladder" onClick={() => navigate("trust")} /></>} />
      <StatRow id="ag-stats">
        <Stat label="Agents" value={String(agents.length)} sub={`${active} active`} tone="info" />
        <Stat label="On autopilot" value={String(agents.filter((a) => a.autonomy === "auto").length)} sub="no gate" />
        <Stat label="Need approval" value={String(agents.filter((a) => a.autonomy === "gate").length)} sub="human gate" tone="wait" />
        <Stat label="Spend, 7 days" value={fmt.money0(agents.reduce((t, a) => t + a.spend7d, 0))} />
      </StatRow>
      <Roster agents={agents} />
    </div>
  );
}
