/**
 * Agents at work (#workspace, no conversation open): who is doing what right now, as the Blueprint prototype draws it. Stat tiles and a grid of
 * agent cards. Conversations (the inbox and every thread) are one click away and keep their own pane.
 */
import type { ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { useAgents, useProjects, useWorkOrdersOf } from "../../api/queries";
import { useScope } from "../work/scope";
import { Async } from "../../ui/async";
import { Spark } from "../../ui/charts";
import { Avatar, Chip, Empty, Meter, Stat, StatRow, ViewHead } from "../../ui/primitives";
import { useCatalog } from "../projects/kit";

/** `tools` (New chat, Conversations, Operator view) are the working chat features: kept, as a quiet row under the cards, never in the header. */
export function AtWork({ tools }: { tools: ReactNode }) {
  const agentsQ = useAgents();
  const scope = useScope();
  const projects = useProjects().data;
  const ids = scope.project ? [scope.project] : (projects ?? []).map((p) => p.id);
  const wosQ = useWorkOrdersOf(ids);
  const cat = useCatalog();
  const agents = agentsQ.data ? agentsQ.data.filter((a) => a.station) : [];
  const running = wosQ.data.filter((w) => w.state === "running");
  const agentOf = (w: { station: number }): string | undefined => cat?.stations[w.station]?.agent;
  const jobsOf = (id: string) => running.filter((w) => agentOf(w) === id);
  const active = agents.filter((a) => jobsOf(a.id).length).length;
  const tokens = running.reduce((n, w) => n + (w.history.at(-1)?.tokens ?? 0), 0);
  const stationName = (id: string | null): string => cat?.stations.find((s) => s.id === id)?.name ?? "its station";
  return (
    <div className="view ws-atwork">
      <ViewHead title="Agents at work" kicker={scope.kicker} sub="Who is doing what right now, across the line." />
      <StatRow id="ws-stats">
        <Stat label="Agents active" value={String(active)} sub={`of ${agents.length}`} />
        <Stat label="Running runs" value={String(running.length)} sub="work orders" />
        <Stat label="Tokens today" value={fmt.k(tokens)} sub="current runs" />
        <Stat label="Autonomy: gate" value={String(agents.filter((a) => a.autonomy === "gate").length)} sub="agents need approval" />
      </StatRow>
      <Async query={agentsQ} what="agents" id="ws-agents" isEmpty={() => false}>
        {() =>
          agents.length ? (
            <div className="card-grid">
              {agents.map((a) => {
                const jobs = jobsOf(a.id);
                return (
                  <a key={a.id} className="card" href={`#agents/${encodeURIComponent(a.id)}`} id={`ws-agent-${a.id}`}>
                    <div className="row">
                      <Avatar id={a.id} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <h3>{a.name}</h3>
                        <div className="small muted trunc">{a.model}</div>
                      </div>
                      <Chip text={jobs.length ? "working" : "idle"} cls={jobs.length ? "ok" : "plain"} />
                    </div>
                    {jobs.length ? (
                      jobs.slice(0, 3).map((w) => (
                        <div key={w.id} className="small trunc">
                          <span className="mono">{w.id}</span>{" " + w.title}
                          <div style={{ marginTop: 4 }}><Meter value={w.progress} max={100} label={`${w.id} progress`} /></div>
                        </div>
                      ))
                    ) : (
                      <div className="small muted">{`Waiting for work at ${stationName(a.station)}`}</div>
                    )}
                    <div className="row small muted">
                      <Spark values={a.spark} w={80} h={22} area={false} />
                      <span>{`success ${fmt.pct(a.evalScore)}`}</span>
                    </div>
                  </a>
                );
              })}
            </div>
          ) : (
            <Empty id="ws-agents-empty" title="No agents on the line" text="Agents appear here once they are assigned to a station." />
          )
        }
      </Async>
      <div className="row ws-tools" style={{ marginTop: 16 }}>{tools}</div>
    </div>
  );
}
