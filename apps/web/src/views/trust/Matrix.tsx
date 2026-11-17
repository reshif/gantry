/** The Control Room matrix: one level per agent and project (the highest of its class cells). A level opens that project's ladder. */
import type { CSSProperties } from "react";
import type { Project } from "@gantry/domain";
import { Card } from "../../ui/cr";
import { Avatar } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/DataTable";
import { rerender, trustUi, type CellOut } from "./kit";

export function MatrixTab({ cells, projects, agents }: { cells: CellOut[]; projects: Project[]; agents: Array<{ id: string; name: string }> }) {
  const withCells = projects.filter((p) => cells.some((c) => c.project === p.id));
  const cols = (withCells.length ? withCells : projects).slice(0, 4);
  const levelOf = (agent: string, project: string): number | null => {
    const mine = cells.filter((c) => c.agent === agent && c.project === project);
    return mine.length ? Math.max(...mine.map((c) => c.effective ?? c.level)) : null;
  };
  const open = (project: string): void => { trustUi.project = project; trustUi.tab = "ladder"; rerender(); };
  const columns: Col<{ id: string; name: string }>[] = [
    { key: "agent", label: "Agent", render: (a) => <span className="row nowrap"><Avatar id={a.id} size="sm" /><b>{a.name}</b></span> },
    ...cols.map((p): Col<{ id: string; name: string }> => ({ key: p.id, label: p.name, render: (a) => {
      const l = levelOf(a.id, p.id);
      return l === null ? <span className="dim">{"\u2013"}</span> : <a className="lvl" href="#trust" style={{ "--l": l } as CSSProperties} id={`tr-mx-${a.id}-${p.id}`} aria-label={`${a.name} on ${p.name}: level ${l}`} onClick={(e) => { e.preventDefault(); open(p.id); }}>{`L${l}`}</a>;
    } })),
  ];
  return (
    <Card title="Autonomy by agent and project" hint="Highest level across classes of work. Open a level to see its ladder.">
      <DataTable id="tr-agent-matrix" caption="Autonomy by agent and project" columns={columns} rows={agents} rowKey={(a) => a.id} />
      <div className="row dim mono" style={{ marginTop: 12, fontSize: 11 }}><span>L0 every output reviewed</span><span>{"·"}</span><span>L2 sample reviewed</span><span>{"·"}</span><span>L3 decided by checks</span></div>
    </Card>
  );
}
