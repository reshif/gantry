/**
 * The work orders Board (prototype `wo-board`): one flush panel, one snap-scrolling column per station of the project's line, each card a link to the
 * record (id and state, title, "P2 · Requester"). A column counts the work orders in it that are not done. The floor's own board (drag, swimlanes,
 * replay) stays on the Floor.
 */
import { flowOf, type Catalog, type Project, type WorkOrder } from "@gantry/domain";
import { hashFor } from "../../lib/router";
import { Empty, Panel } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { WoStateChip } from "./cells";

export function WoBoard({ items, cat, project }: { items: WorkOrder[]; cat: Catalog; project: Project }) {
  const actor = useActors();
  const line = flowOf(cat, project).stations.filter((s) => s.enabled);
  const byStation = (id: string) => items.filter((w) => cat.stations[w.station]?.id === id && w.state !== "done");
  return (
    <Panel title="Board" flush id="wo-board">
      <div className="board" aria-label="Work orders by station">
        {line.map((s) => {
          const col = byStation(s.id);
          return (
            <div className="col" key={s.id}>
              <h3><span>{`${s.no} ${s.name}`}</span><span>{col.length}</span></h3>
              <div className="cards">
                {col.map((w) => (
                  <a className="card" key={w.id} href={hashFor("record", w.id, project.id)} id={`wo-card-${w.id}`}>
                    <div className="row"><span className="mono small">{w.id}</span><span className="spacer" /><WoStateChip w={w} cat={cat} project={project} /></div>
                    <div>{w.title}</div>
                    <div className="small muted">{`${w.priority} · ${actor(w.requestedBy).name}`}</div>
                  </a>
                ))}
              </div>
            </div>
          );
        })}
        {!line.length ? <Empty title="Nothing here yet" text="Items will appear here when they exist." /> : null}
      </div>
    </Panel>
  );
}
