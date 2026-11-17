/**
 * Projects (#projects), the Control Room portfolio: eyebrow, stat row, filter bar with a Table / Cards / Templates switch, then the
 * projects as a table or a card grid. Each project is a line in the factory (repos, flow, approvers, budget, kill switch); the New
 * project wizard and templates are unchanged. Read through useProjects / useTemplates; the "create" right comes from useCan.
 */
import { useEffect, useMemo, useState } from "react";
import { useCan } from "../api/can";
import { useMe, useProjects, useTemplates } from "../api/queries";
import { registerCommand } from "../lib/commands";
import { usePrefs } from "../lib/prefs";
import { Btn, Chip, FilterBar, Meter, SearchBox, Segmented, Select, Who } from "../ui/primitives";
import { Async } from "../ui/async";
import { DataTable } from "../ui/DataTable";
import { Page, Stats } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { TemplatesTab } from "./projects/templates";
import { NewProjectWizard } from "./projects/wizard";
import { goProject, HealthChip, metricsOf, type PView } from "./projects/kit";
import { EmptyState } from "./projects/kit";

type Layout = "table" | "cards" | "templates";
const ACTIVE = (p: PView) => p.status !== "archived";
const stateOf = (p: PView): "halted" | "running" | "archived" => (p.status === "archived" ? "archived" : p.killed || p.halted || metricsOf(p).health.id === "halted" || metricsOf(p).health.id === "killed" ? "halted" : "running");

function StateChip({ p }: { p: PView }) {
  const s = stateOf(p);
  return <Chip text={s === "halted" ? "Halted" : s === "archived" ? "Archived" : "Running"} cls={s === "halted" ? "warn" : s === "archived" ? "idle" : "info"} />;
}

export default function ProjectsView() {
  const ui = useUI();
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const tplsQ = useTemplates();
  const projects = ((projectsQ.data ?? []) as PView[]).slice();
  const tpls = tplsQ.data ?? [];
  const create = useCan("project.create");
  const [layout, setLayout] = useState<Layout>("table");
  const [q, setQ] = useState("");
  const [st, setSt] = useState("all");
  const [reg, setReg] = useState("all");
  const current = projects.find((p) => p.id === prefs.project) ?? null;

  const openWizard = (tplId?: string) => {
    ui.open((close) => <NewProjectWizard tplId={tplId} projects={projects} close={close} />);
  };
  useEffect(() => registerCommand("newProject", () => { if (create.allowed) openWizard(); }), [create.allowed, projects.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return projects.filter((p) => {
      if (st === "archived" ? ACTIVE(p) : !ACTIVE(p)) return false;
      if (st !== "all" && st !== "archived" && stateOf(p) !== st) return false;
      if (reg !== "all" && (reg === "yes") !== !!p.regulated) return false;
      return !needle || `${p.name} ${p.key} ${p.desc || ""} ${p.id}`.toLowerCase().includes(needle);
    });
  }, [projects, q, st, reg]);

  if (!me) return null;
  const live = projects.filter(ACTIVE);
  const total = live.length;
  const halted = live.filter((p) => stateOf(p) === "halted").length;
  const wipAll = Math.max(1, live.reduce((n, p) => n + metricsOf(p).wip + metricsOf(p).bays, 0));

  const table = (
    <DataTable<PView>
      id="prj-table"
      caption="Projects"
      rows={rows}
      rowKey={(p) => p.id}
      rowId={(p) => `prj-row-${p.id}`}
      pageSize={10}
      sort={{ key: "name", dir: 1 }}
      empty={{ title: "No projects match", text: "Clear a filter or search for something else." }}
      columns={[
        { key: "name", label: "Project", sort: (p) => p.name.toLowerCase(), render: (p) => (<><a className="rl ell" id={`prj-open-${p.id}`} href="#projects" onClick={(e) => { e.preventDefault(); goProject(p.id, "project-config"); }}>{p.name}</a><span className="dim ell" style={{ fontSize: 12 }}>{p.desc}</span></>) },
        { key: "key", label: "Key", render: (p) => <span className="tag">{p.key.toUpperCase()}</span> },
        { key: "owner", label: "Owner", sort: (p) => p.owner, render: (p) => <Who id={p.owner} /> },
        { key: "wip", label: "On belt", align: "end", sort: (p) => metricsOf(p).wip + metricsOf(p).bays, render: (p) => <span className="mono">{metricsOf(p).wip + metricsOf(p).bays}</span> },
        { key: "bad", label: "Blocked", align: "end", sort: (p) => metricsOf(p).bad, render: (p) => <span className="mono" style={{ color: metricsOf(p).bad ? "var(--bad)" : "var(--text-3)" }}>{metricsOf(p).bad}</span> },
        { key: "status", label: "Status", sort: (p) => stateOf(p), render: (p) => <StateChip p={p} /> },
        { key: "reg", label: "Regulated", sort: (p) => (p.regulated ? 1 : 0), render: (p) => (p.regulated ? <Chip text="Regulated" cls="agent" /> : <span className="dim">—</span>) },
      ]}
    />
  );
  const cards = rows.length ? (
    <div className="grid g3">
      {rows.map((p) => {
        const m = metricsOf(p);
        return (
          <a key={p.id} className="card" id={`prj-card-${p.id}`} href="#projects" style={{ color: "inherit", textDecoration: "none" }} onClick={(e) => { e.preventDefault(); goProject(p.id, "project-config"); }}>
            <div className="card-h">
              <div className="row nowrap" style={{ minWidth: 0 }}><span className="tag">{p.key.toUpperCase()}</span><h3 className="ell">{p.name}</h3></div>
              <StateChip p={p} />
            </div>
            <div className="card-b stack" style={{ gap: 12 }}>
              <p className="muted">{p.desc}</p>
              <div className="row spread">
                <span className="mono"><b>{m.wip + m.bays}</b> on belt</span>
                <span className="mono" style={{ color: m.bad ? "var(--bad)" : "var(--text-3)" }}>{m.bad} blocked</span>
                <span className="mono dim">{m.gates} gate{m.gates === 1 ? "" : "s"}</span>
              </div>
              <Meter value={m.wip + m.bays} max={wipAll} label={`${p.name} share of work on the belt`} />
              <div className="row"><Who id={p.owner} /><HealthChip p={p} /></div>
            </div>
          </a>
        );
      })}
    </div>
  ) : (
    <div className="card"><EmptyState title="No projects match" text="Clear a filter or search for something else." /></div>
  );

  return (
    <Page
      eyebrow="Portfolio" title="Projects" cls="prj"
      sub="Every project on the line with its owner, work in flight and state."
      acts={<Btn kind="primary" icon="plus" id="prj-new" guard={create} label="New project" onClick={() => openWizard()} />}
    >
      <Stats id="prj-stats" items={[
        { l: "Projects", v: total, tone: "info" },
        { l: "Running", v: total - halted, tone: "ok" },
        { l: "Halted", v: halted, tone: "warn" },
        { l: "Regulated", v: live.filter((p) => p.regulated).length, tone: "agent" },
      ]} />
      <FilterBar
        label="Filter projects"
        count={layout === "templates" ? `${tpls.length} template${tpls.length === 1 ? "" : "s"}` : `${rows.length} of ${projects.length} shown`}
        actions={<Segmented name="prj-layout" label="Layout" value={layout} onChange={(v) => setLayout(v as Layout)} items={[{ id: "table", label: "Table" }, { id: "cards", label: "Cards" }, { id: "templates", label: "Templates" }]} />}
      >
        <SearchBox id="prj-q" value={q} onChange={setQ} placeholder="Search projects" />
        <Select id="prj-st" aria-label="Status" value={st} onChange={setSt} options={[{ value: "all", label: "Status: all" }, { value: "running", label: "Running" }, { value: "halted", label: "Halted" }, { value: "archived", label: "Archived" }]} />
        <Select id="prj-reg" aria-label="Regulated" value={reg} onChange={setReg} options={[{ value: "all", label: "Regulated: all" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
      </FilterBar>
      {layout === "templates" ? (
        <Async query={tplsQ} what="templates" id="prj-tpl">{() => <TemplatesTab projects={projects} current={current} onUse={openWizard} />}</Async>
      ) : (
        <Async query={projectsQ} what="projects" id="prj-pf">{() => (layout === "cards" ? cards : table)}</Async>
      )}
    </Page>
  );
}
