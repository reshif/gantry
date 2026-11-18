/** The portfolio as the Blueprint draws it: a card grid or a five-column table. Ported from the prototype's SCREENS.projects. */
import { fmt } from "@gantry/domain";
import { useWorkOrders } from "../../api/queries";
import { hashFor } from "../../lib/router";
import { setProject } from "../../lib/prefs";
import { useActors } from "../../ui/actors";
import { Btn, Chip, Meter, Panel } from "../../ui/primitives";
import { goProject, metricsOf, type PView } from "./kit";
import { ProtoList } from "./protolist";

/** Work orders done in one project, read from its work-order list (the portfolio metrics do not carry it). */
export function useDoneCount(projectId: string): number | null {
  const q = useWorkOrders(projectId, { state: "done", limit: 200 });
  const d = q.data;
  if (!d) return null;
  return (Array.isArray(d) ? d : d.items).filter((w) => w.state === "done").length;
}

function Done({ id }: { id: string }) {
  const n = useDoneCount(id);
  return <><span className="num">{n == null ? "–" : String(n)}</span> done</>;
}

export const configHref = (p: PView): string => hashFor("project-config", null, p.id);

function Card({ p, owner }: { p: PView; owner: string }) {
  const m = metricsOf(p);
  return (
    <div className="card" id={`prj-card-${p.id}`}>
      <div className="row">
        <span className="mono small" style={{ border: "1px solid var(--accent)", color: "var(--accent)", padding: "0 6px" }}>{p.key}</span>
        <h3 className="grow">{p.name}</h3>
      </div>
      {p.regulated ? <div className="row"><Chip text="regulated" cls="warn" /></div> : null}
      <div className="small muted">{p.desc}</div>
      <div className="row small"><span className="num">{String(m.wip)}</span> in flight · <span className="num">{String(m.gates)}</span> at gates · <Done id={p.id} /></div>
      <Meter value={p.budget.mtd} max={p.budget.monthly} label={`${p.name} spend`} warnAt={p.budget.alertAt} />
      <div className="small muted">{`${fmt.money0(p.budget.mtd)} of ${fmt.money0(p.budget.monthly)} · owner ${owner}`}</div>
      <div className="row">
        <Btn small kind="primary" id={`prj-floor-${p.id}`} aria={`Open the floor for ${p.name}`} label="Open Floor" onClick={() => goProject(p.id, "floor")} />
        <Btn small id={`prj-cfg-${p.id}`} aria={`Configure ${p.name}`} label="Config" onClick={() => goProject(p.id, "project-config")} />
      </div>
    </div>
  );
}

export function ProjectGrid({ projects }: { projects: PView[] }) {
  const actor = useActors();
  return <div className="card-grid">{projects.map((p) => <Card key={p.id} p={p} owner={actor(p.owner).name.replace(" (agent)", "")} />)}</div>;
}

export function ProjectTable({ projects }: { projects: PView[] }) {
  const actor = useActors();
  const who = (id: string) => actor(id).name.replace(" (agent)", "");
  return (
    <Panel flush>
      <ProtoList<PView>
        id="prj-table" noun="project" rows={projects} rowKey={(p) => p.id} text={(p) => p.name + p.key + (p.desc ?? "")}
        filters={[{ k: "status", label: "Status", opts: ["active", "paused", "archived"], fn: (p, v) => (v === "paused" ? !!(p.halted || p.killed) : p.status === v) }]}
        cols={[
          { key: "n", label: "Project", sort: (p) => p.name, render: (p) => <div><a className="pri" href={configHref(p)} onClick={() => setProject(p.id)}>{p.name}</a><span className="sub">{`${p.key} · ${p.desc ?? ""}`}</span></div> },
          { key: "o", label: "Owner", sort: (p) => who(p.owner), render: (p) => who(p.owner) },
          { key: "l", label: "In flight", align: "end", sort: (p) => metricsOf(p).wip, render: (p) => String(metricsOf(p).wip) },
          { key: "b", label: "Budget", align: "end", sort: (p) => (p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0), render: (p) => <span className="num">{fmt.pct(p.budget.monthly ? p.budget.mtd / p.budget.monthly : 0)}</span> },
          { key: "s", label: "Status", render: (p) => <Chip text={p.status} cls={p.status === "active" ? "ok" : "plain"} /> },
        ]}
      />
    </Panel>
  );
}
