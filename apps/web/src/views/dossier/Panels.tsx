/** The Document tab's first panels and the Gates and Runs tabs of a work order page (Blueprint prototype: Brief, Acceptance criteria, Plan; Gate decisions; Station runs). */
import { fmt, type Catalog } from "@gantry/domain";
import { Chip, Empty, Panel } from "../../ui/primitives";
import { DataTable, type Col } from "../../ui/SortTable";
import { useActors } from "../../ui/actors";
import type { TWo } from "../traveler/model";

const label = (k: string): string => k.replace(/([A-Z])/g, " $1");

export function BriefPanel({ wo }: { wo: TWo }) {
  const b = wo.brief as unknown as Record<string, unknown> | undefined;
  const entries = Object.entries(b ?? {}).filter(([k, v]) => k !== "route" && v && (!Array.isArray(v) || v.length));
  return (
    <Panel title="Brief">
      {entries.length ? (
        <div className="stack" id="dz-brief">
          {entries.map(([k, v]) => (
            <div key={k}>
              <div className="micro">{label(k)}</div>
              {Array.isArray(v) ? <ul style={{ margin: "4px 0", paddingLeft: 18 }}>{v.map((x, i) => <li key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</li>)}</ul> : <p>{typeof v === "object" ? JSON.stringify(v) : String(v)}</p>}
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No brief yet" text="The Intake agent writes it once the conversation completes." />
      )}
    </Panel>
  );
}

export function CriteriaPanel({ wo }: { wo: TWo }) {
  const list = wo.criteria ?? [];
  return (
    <Panel title="Acceptance criteria" flush>
      {list.length ? (
        <ul className="list">
          {list.map((c) => (
            <li key={c.id}>
              <span className="mono small">{c.id}</span>
              <span className="grow">{c.text}</span>
              <Chip text={c.status} cls={c.status === "passing" || c.status === "met" ? "ok" : c.status === "failing" ? "bad" : "plain"} />
            </li>
          ))}
        </ul>
      ) : <div className="empty">None recorded yet.</div>}
    </Panel>
  );
}

export function PlanPanel({ wo }: { wo: TWo }) {
  const list = wo.plan ?? [];
  return (
    <Panel title="Plan" flush>
      {list.length ? (
        <ol className="list" style={{ paddingLeft: 0 }}>
          {list.map((p) => (
            <li key={p.id}>
              <span className="mono small">{p.id}</span>
              <div className="grow">
                <div>{p.text}</div>
                <div className="small muted mono">{(p.files ?? []).join(", ")}</div>
              </div>
              {(p.ac ?? []).map((a) => <Chip key={a} text={a} cls="plain" />)}
            </li>
          ))}
        </ol>
      ) : <div className="empty">The Plan station has not written a plan yet.</div>}
    </Panel>
  );
}

export function GatesPanel({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const actor = useActors();
  const rows = Object.entries(wo.gates ?? {}).map(([k, g]) => ({ k, ...g }));
  const def = (k: string) => cat.gates.find((x) => x.id === k);
  const cols: Col<(typeof rows)[number]>[] = [
    { key: "k", label: "Gate", render: (g) => <span className="pri-cell"><b className="mono">{g.k}</b><span className="sub">{def(g.k)?.name}</span></span> },
    { key: "kind", label: "Kind", render: (g) => def(g.k)?.kind ?? "" },
    { key: "s", label: "Status", render: (g) => <Chip text={g.status} cls={g.status === "passed" ? "ok" : g.status === "waiting" ? "warn" : g.status === "failed" ? "bad" : "plain"} /> },
    { key: "by", label: "Decided by", render: (g) => { const d = g.approvals[0] ?? g.rejections[0]; return d ? actor(d.by).name : g.decision?.mode === "trust" ? "Under trust" : "—"; } },
    { key: "at", label: "When", render: (g) => { const d = g.approvals[0] ?? g.rejections[0]; return d ? `${fmt.dur(Date.now() - d.at)} ago` : "—"; } },
  ];
  return (
    <Panel title="Gate decisions" flush>
      <DataTable id="dz-gates" caption={`Gate decisions for ${wo.id}`} columns={cols} rows={rows} rowKey={(g) => g.k} />
    </Panel>
  );
}

export function RunsPanel({ wo, cat }: { wo: TWo; cat: Catalog }) {
  const actor = useActors();
  const cols: Col<TWo["history"][number]>[] = [
    { key: "station", label: "Station", render: (x) => cat.stations.find((s) => s.id === x.station)?.name ?? x.station },
    { key: "agent", label: "Agent", render: (x) => actor(x.agent).name + (x.agentVersion ? ` v${x.agentVersion}` : "") },
    { key: "model", label: "Model", render: (x) => <span className="mono small">{x.model}</span> },
    { key: "dur", label: "Duration", align: "end", render: (x) => (x.endedAt ? `${Math.round((x.endedAt - x.startedAt) / 60000)} min` : "running") },
    { key: "tok", label: "Tokens", align: "end", render: (x) => <span className="num">{fmt.k(x.tokens)}</span> },
    { key: "cost", label: "Cost", align: "end", render: (x) => <span className="num">{fmt.money(x.cost)}</span> },
    { key: "o", label: "Outcome", render: (x) => (x.outcome ? <Chip text={x.outcome} cls={x.outcome === "passed" ? "ok" : "bad"} /> : <Chip text="active" cls="info" />) },
  ];
  return (
    <Panel title="Station runs" flush>
      <DataTable id="dz-runs" caption={`Station runs for ${wo.id}`} columns={cols} rows={wo.history} rowKey={(x) => `${x.station}-${x.startedAt}`} />
    </Panel>
  );
}
