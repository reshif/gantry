/**
 * Projects (#projects), the Control Room portfolio: eyebrow, stat row, filter bar (search, Status, Regulated, Table / Cards) and the
 * projects as a table or a card grid. Search, filters, layout and sort live in the URL (`?q=&st=&reg=&view=&sort=&dir=`). Each project
 * is a line in the factory; "New project" opens the small prototype dialog, which offers the full wizard (repos, budget, approvers)
 * under "More options". Read through useProjects; the "create" right comes from useCan. The template library stays reachable at `?view=templates`.
 */
import { useEffect, useMemo, useState } from "react";
import { useCan } from "../api/can";
import { useMe, usePeople, useProjects, useTemplates } from "../api/queries";
import { registerCommand } from "../lib/commands";
import { usePrefs } from "../lib/prefs";
import { Btn, Chip, FilterBar, Meter, SearchBox, Segmented, Select, Who } from "../ui/primitives";
import { Async } from "../ui/async";
import { DataTable } from "../ui/DataTable";
import { Page, Stats } from "../ui/cr";
import { useUI } from "../ui/overlay-context";
import { TemplatesTab } from "./projects/templates";
import { NewProjectDialog } from "./projects/NewProjectDialog";
import { NewProjectWizard } from "./projects/wizard";
import { goProject, metricsOf, type PView } from "./projects/kit";
import { EmptyState } from "./projects/kit";
import { useRepoCounts } from "./projects/repo-counts";
import { useParam, useParams } from "./projects/url";

const stateOf = (p: PView): "halted" | "running" | "archived" => (p.status === "archived" ? "archived" : p.killed || p.halted || metricsOf(p).health.id === "halted" || metricsOf(p).health.id === "killed" ? "halted" : "running");

function StateChip({ p }: { p: PView }) {
  const s = stateOf(p);
  return <Chip text={s === "halted" ? "Halted" : s === "archived" ? "Archived" : "Running"} cls={s === "halted" ? "warn" : s === "archived" ? "idle" : "ok"} />;
}

export default function ProjectsView() {
  const ui = useUI();
  const me = useMe();
  const prefs = usePrefs();
  const projectsQ = useProjects();
  const tplsQ = useTemplates();
  const people = usePeople().data ?? [];
  const all = ((projectsQ.data ?? []) as PView[]).slice();
  const tpls = tplsQ.data ?? [];
  const create = useCan("project.create");
  const [, setParams] = useParams();
  const [view] = useParam("view", "table", ["table", "cards", "templates"]);
  const [q] = useParam("q", "");
  const [st] = useParam("st", "all", ["all", "running", "halted", "archived"]);
  const [reg] = useParam("reg", "all", ["all", "yes", "no"]);
  const [sortKey] = useParam("sort", "name");
  const [dir] = useParam("dir", "asc", ["asc", "desc"]);
  // typing is local; the URL follows 140 ms later
  const [typed, setTyped] = useState(q);
  useEffect(() => setTyped(q), [q]);
  useEffect(() => {
    if (typed === q) return;
    const t = setTimeout(() => setParams({ q: typed.trim() ? typed : null }), 140);
    return () => clearTimeout(t);
  }, [typed, q, setParams]);

  // Archived projects stay out of the portfolio unless `?st=archived` asks for them (the status select offers only Running and Halted).
  const projects = all.filter((p) => (st === "archived" ? stateOf(p) === "archived" : stateOf(p) !== "archived"));
  const repoCounts = useRepoCounts(projects.map((p) => p.id));
  const current = all.find((p) => p.id === prefs.project) ?? null;
  const nameOf = (id: string) => people.find((x) => x.id === id)?.name ?? "";

  const openWizard = (tplId?: string) => {
    ui.open((close) => <NewProjectWizard tplId={tplId} projects={all} close={close} />);
  };
  const openNew = () => ui.open((close) => <NewProjectDialog projects={all} close={close} more={() => openWizard()} />);
  useEffect(() => registerCommand("newProject", () => { if (create.allowed) openNew(); }), [create.allowed, all.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return projects.filter((p) => {
      if ((st === "running" || st === "halted") && stateOf(p) !== st) return false;
      if (reg !== "all" && (reg === "yes") !== !!p.regulated) return false;
      return !needle || [p.name, p.key, p.desc || "", nameOf(p.owner)].join(" ").toLowerCase().includes(needle);
    });
  }, [projects, q, st, reg, people]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = () => { setTyped(""); setParams({ q: null, st: null, reg: null }); };
  const filtered = !!(q || st !== "all" || reg !== "all");

  if (!me) return null;
  const live = all.filter((p) => stateOf(p) !== "archived");
  const total = live.length;
  const halted = live.filter((p) => stateOf(p) === "halted").length;
  const belt = (p: PView) => metricsOf(p).wip + metricsOf(p).bays;
  const beltAll = Math.max(1, live.reduce((n, p) => n + belt(p), 0));
  const repoText = (p: PView): string => (repoCounts[p.id] == null ? "not available" : String(repoCounts[p.id]));

  const table = (
    <DataTable<PView>
      id="prj-table"
      caption="Projects"
      rows={rows}
      rowKey={(p) => p.id}
      rowId={(p) => `prj-row-${p.id}`}
      pageSize={10}
      pager
      sort={{ key: sortKey, dir: dir === "desc" ? -1 : 1 }}
      onSort={(s) => setParams({ sort: s.key === "name" ? null : s.key, dir: s.dir === -1 ? "desc" : null })}
      empty={{ title: "Nothing matches", text: "Try clearing a filter or searching for something else.", action: filtered ? <Btn small id="prj-clear-empty" label="Clear filters" onClick={clear} /> : undefined }}
      columns={[
        { key: "name", label: "Project", sort: (p) => p.name.toLowerCase(), render: (p) => (<><a className="rl ell" id={`prj-open-${p.id}`} href={`#/p/${encodeURIComponent(p.id)}/project-config/${encodeURIComponent(p.id)}`} onClick={(e) => { e.preventDefault(); goProject(p.id, "project-config"); }}>{p.name}</a><span className="dim ell" style={{ fontSize: 12 }}>{p.desc}</span></>) },
        { key: "key", label: "Key", sort: (p) => p.key, render: (p) => <span className="tag">{p.key.toUpperCase()}</span> },
        { key: "owner", label: "Owner", sort: (p) => nameOf(p.owner), render: (p) => <Who id={p.owner} /> },
        { key: "repos", label: "Repos", align: "end", sort: (p) => repoCounts[p.id] ?? -1, render: (p) => <span className="mono">{repoText(p)}</span> },
        { key: "wip", label: "On belt", align: "end", sort: belt, render: (p) => <span className="mono">{belt(p)}</span> },
        { key: "bad", label: "Blocked", align: "end", sort: (p) => metricsOf(p).bad, render: (p) => <span className="mono" style={{ color: metricsOf(p).bad ? "var(--bad)" : "var(--text-3)" }}>{metricsOf(p).bad}</span> },
        { key: "status", label: "Status", sort: (p) => stateOf(p), render: (p) => <StateChip p={p} /> },
        { key: "reg", label: "Regulated", sort: (p) => (p.regulated ? 1 : 0), render: (p) => (p.regulated ? <Chip text="Regulated" cls="agent" /> : <span className="dim">—</span>) },
      ]}
    />
  );
  const cards = rows.length ? (
    <div className="grid g3">
      {rows.map((p) => (
        <a key={p.id} className="card" id={`prj-card-${p.id}`} href={`#/p/${encodeURIComponent(p.id)}/project-config/${encodeURIComponent(p.id)}`} style={{ color: "inherit", textDecoration: "none" }} onClick={(e) => { e.preventDefault(); goProject(p.id, "project-config"); }}>
          <div className="card-h">
            <div className="row nowrap" style={{ minWidth: 0 }}><span className="tag">{p.key.toUpperCase()}</span><h3 className="ell">{p.name}</h3></div>
            <StateChip p={p} />
          </div>
          <div className="card-b stack" style={{ gap: 12 }}>
            <p className="muted">{p.desc}</p>
            <div className="row spread">
              <span className="mono"><b>{belt(p)}</b> on belt</span>
              <span className="mono" style={{ color: metricsOf(p).bad ? "var(--bad)" : "var(--text-3)" }}>{metricsOf(p).bad} blocked</span>
              <span className="mono dim">{repoCounts[p.id] == null ? "repos not available" : `${repoCounts[p.id]} repos`}</span>
            </div>
            <Meter value={Math.min(100, (belt(p) / beltAll) * 400)} max={100} label={`${p.name} share of work on the belt`} />
            <div className="row"><Who id={p.owner} /></div>
          </div>
        </a>
      ))}
    </div>
  ) : (
    <div className="card"><EmptyState title="Nothing matches" text="Try clearing a filter or searching for something else." /></div>
  );

  return (
    <Page
      eyebrow="Portfolio" title="Projects" cls="prj"
      sub="Every project on the line with its owner, work in flight and state."
      acts={<Btn kind="primary" icon="plus" id="prj-new" guard={create} label="New project" onClick={() => openNew()} />}
    >
      <Stats id="prj-stats" items={[
        { l: "Projects", v: total, tone: "info" },
        { l: "Running", v: total - halted, tone: "ok" },
        { l: "Halted", v: halted, tone: "warn" },
        { l: "Regulated", v: live.filter((p) => p.regulated).length, tone: "agent" },
      ]} />
      <FilterBar
        label="Filter projects"
        count={view === "templates" ? `${tpls.length} template${tpls.length === 1 ? "" : "s"}` : `${rows.length} of ${projects.length}`}
        actions={
          <>
            {filtered ? <Btn small kind="ghost" id="prj-clear" label="Clear" onClick={clear} /> : null}
            <Segmented name="prj-layout" label="Layout" value={view === "cards" ? "cards" : "table"} onChange={(v) => setParams({ view: v === "table" ? null : v })} items={[{ id: "table", label: "Table" }, { id: "cards", label: "Cards" }]} />
          </>
        }
      >
        <SearchBox id="prj-q" value={typed} onChange={setTyped} placeholder="Search projects" />
        <Select id="prj-st" aria-label="Status" value={st === "archived" ? "all" : st} onChange={(v) => setParams({ st: v === "all" ? null : v })} options={[{ value: "all", label: "Status: all" }, { value: "running", label: "Running" }, { value: "halted", label: "Halted" }]} />
        <Select id="prj-reg" aria-label="Regulated" value={reg} onChange={(v) => setParams({ reg: v === "all" ? null : v })} options={[{ value: "all", label: "Regulated: all" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
      </FilterBar>
      {view === "templates" ? (
        <Async query={tplsQ} what="templates" id="prj-tpl">{() => <TemplatesTab projects={all} current={current} onUse={openWizard} />}</Async>
      ) : (
        <Async query={projectsQ} what="projects" id="prj-pf">{() => (view === "cards" ? cards : table)}</Async>
      )}
    </Page>
  );
}
