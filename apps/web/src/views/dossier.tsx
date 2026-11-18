/**
 * Repo dossier (prototype "Dossier"): `#/p/<project>/dossier` lists the repositories under Gantry, `#/p/<project>/dossier/<repo>` is one repo's
 * configuration, guidelines (AGENTS.md) and work orders. The work order page is views/dossier/ (its folder name predates this screen).
 */
import { useMemo } from "react";
import type { Repo, WorkOrder } from "@gantry/domain";
import { useMe, useWorkOrders } from "../api/queries";
import { Async } from "../ui/async";
import { Btn, Chip, Empty, Field, FilterBar, Panel, SearchBox, Select, Stat, StatRow, ViewHead } from "../ui/primitives";
import { DataTable, type Col } from "../ui/DataTable";
import { hashFor, navigate, useHash } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { pickProject } from "../lib/routes";
import { useQueryParam } from "./floor/urlState";
import { useProjectRepos } from "./floor/kit";
import { useProject } from "../api/queries";
import { WoStatus } from "./dossier/stateTone";

const useWos = (projectId: string | null) => {
  const read = useWorkOrders(projectId, { state: "all", limit: 200 });
  const items = useMemo<WorkOrder[]>(() => (Array.isArray(read.data) ? read.data : (read.data?.items ?? [])), [read.data]);
  return { read, items };
};

function useProjectId(): string | null {
  const me = useMe();
  const prefs = usePrefs();
  const hash = useHash();
  return hash.project ?? (me ? pickProject(me, prefs.project) : null);
}

function Missing({ title }: { title: string }) {
  return (
    <div className="view rec-view" id="dos-missing">
      <ViewHead plain title={title} />
      <Panel><Empty title="Nothing to show" text="That repo does not exist." action={<Btn label="Work orders" id="dos-missing-wos" onClick={() => navigate("work-orders")} />} /></Panel>
    </div>
  );
}

function Index({ projectId }: { projectId: string | null }) {
  const repos = useProjectRepos(projectId);
  const project = useProject(projectId).data;
  const { items } = useWos(projectId);
  const [q, setQ] = useQueryParam("q");
  const [lang, setLang] = useQueryParam("lang");
  const open = (r: Repo) => items.filter((w) => w.repo === r.id && w.state !== "done").length;
  const needle = (q ?? "").trim().toLowerCase();
  const rows = repos.filter((r) => (!needle || `${r.name} ${r.lang} ${r.tags.join(" ")}`.toLowerCase().includes(needle)) && (!lang || lang === "all" || r.lang === lang));
  const langs = [...new Set(repos.map((r) => r.lang))];
  const filtered = !!needle || (!!lang && lang !== "all");
  const clear = () => { setQ(null); setLang(null); };
  const cols: Col<Repo>[] = [
    { key: "name", label: "Repo", sort: (r) => r.name, render: (r) => <span className="pri-cell"><a className="pri" href={hashFor("dossier", r.id, projectId)} onClick={(e) => { e.preventDefault(); navigate("dossier", r.id, projectId); }}>{r.name}</a><span className="sub">{project?.name ?? r.project}</span></span> },
    { key: "lang", label: "Lang", sort: (r) => r.lang },
    { key: "tags", label: "Tags", render: (r) => <div className="row">{r.tags.map((t) => <Chip key={t} text={t} cls="plain ghost" />)}</div> },
    { key: "wos", label: "Open WOs", align: "end", sort: (r) => open(r), render: (r) => open(r) },
    { key: "h", label: "Status", render: (r) => (r.halted ? <Chip text="halted" cls="warn" /> : <Chip text="active" cls="ok" />) },
  ];
  return (
    <div className="view rec-view" id="dos-index">
      <ViewHead plain title="Dossier" sub="Repositories under Gantry: configuration, guidelines and work." />
      <Panel flush>
        <FilterBar label="Filter repos" count={`${rows.length} ${rows.length === 1 ? "repo" : "repos"}`} actions={filtered ? <Btn label="Clear" small kind="ghost" id="dos-clear" onClick={clear} /> : undefined}>
          <SearchBox id="dos-q" value={q ?? ""} onChange={(v) => setQ(v || null)} placeholder="Search repos" label="Search" />
          <Field label="Language" htmlFor="dos-f-lang">
            <Select id="dos-f-lang" options={[{ value: "all", label: "All" }, ...langs.map((l) => ({ value: l, label: l }))]} value={lang ?? "all"} onChange={(v) => setLang(v === "all" ? null : v)} />
          </Field>
        </FilterBar>
        <DataTable id="dos-table" caption="Repositories" columns={cols} rows={rows} rowKey={(r) => r.id} pageSize={15} empty={{ title: filtered ? "Nothing matches these filters" : "No repositories", text: filtered ? "Try fewer filters." : "Onboard a repo to see it here.", action: filtered ? <Btn label="Clear filters" id="dos-clear-empty" onClick={clear} /> : undefined }} />
      </Panel>
    </div>
  );
}

function Detail({ projectId, repoId }: { projectId: string | null; repoId: string }) {
  const repos = useProjectRepos(projectId);
  const project = useProject(projectId);
  const { read, items } = useWos(projectId);
  const x = repos.find((r) => r.id === repoId);
  if (!x) return project.isLoading || read.isLoading ? <div className="view rec-view" /> : <Missing title="Dossier" />;
  const ws = items.filter((w) => w.repo === x.id);
  return (
    <div className="view rec-view" id="dos-detail">
      <ViewHead
        plain
        kicker={<span style={{ display: "inline-flex", gap: 8 }}><a href={hashFor("dossier", null, projectId)} onClick={(e) => { e.preventDefault(); navigate("dossier", null, projectId); }}>Dossier</a><span aria-hidden="true">/</span><span>{x.name}</span></span>}
        title={x.name}
        sub={`${project.data?.name ?? x.project} · ${x.lang}`}
        actions={<Btn label="Open work orders" id="dos-open-wos" onClick={() => navigate("work-orders", null, projectId)} />}
      />
      <StatRow>
        <Stat label="Open" value={String(ws.filter((w) => w.state !== "done").length)} tone="info" />
        <Stat label="Done" value={String(ws.filter((w) => w.state === "done").length)} tone="done" />
        <Stat label="Merge" value={x.config.merge} sub={x.config.defaultBranch} />
        <Stat label="Tagging" value={x.config.tagging} />
        <Stat label="Triggers" value={x.triggers ? "On" : "Off"} />
      </StatRow>
      <div className="cols">
        <Panel title="Configuration">
          <dl className="kv">
            <dt>Default branch</dt><dd>{x.config.defaultBranch}</dd>
            <dt>Branch prefix</dt><dd>{x.config.branchPrefix}</dd>
            <dt>Required checks</dt><dd><div className="row">{x.config.requiredChecks.map((c) => <Chip key={c} text={c} cls="plain" />)}</div></dd>
            <dt>Protected paths</dt><dd><div className="pre">{x.config.protectedPaths.join("\n")}</div></dd>
            <dt>MCP</dt><dd><div className="row">{(x.mcp ?? []).map((m) => <a key={m} href={hashFor("mcp", m)} onClick={(e) => { e.preventDefault(); navigate("mcp", m); }}>{m}</a>)}</div></dd>
          </dl>
        </Panel>
        <Panel title="AGENTS.md guidelines"><pre className="pre">{x.guidelines || "No guidelines file."}</pre></Panel>
      </div>
      <div style={{ marginTop: 16 }}>
        <Panel title="Work orders" flush>
          <Async query={read} what="the work orders" id="dos-wos" isEmpty={() => false}>
            {() =>
              ws.length ? (
                <ul className="list">
                  {ws.slice(0, 10).map((w) => (
                    <li key={w.id}>
                      <a className="mono pri" href={hashFor("record", w.id, w.project)} onClick={(e) => { e.preventDefault(); navigate("record", w.id, w.project); }}>{w.id}</a>
                      <span className="grow trunc">{w.title}</span>
                      <WoStatus state={w.state} gate={Object.entries(w.gates ?? {}).find(([, g]) => g.status === "waiting")?.[0]} />
                    </li>
                  ))}
                </ul>
              ) : <div className="empty">No work orders for this repo.</div>
            }
          </Async>
        </Panel>
      </div>
    </div>
  );
}

export default function DossierView() {
  const hash = useHash();
  const projectId = useProjectId();
  return hash.param ? <Detail projectId={projectId} repoId={hash.param} /> : <Index projectId={projectId} />;
}
