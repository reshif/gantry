/**
 * Agents at work (#workspace, no conversation open): who is doing what right now, as the Blueprint prototype draws it. Stat tiles and a grid of
 * agent cards. Conversations (the inbox and every thread) are one click away and keep their own pane.
 */
import { fmt } from "@gantry/domain";
import { useAgents, useProjects, useWorkOrdersOf } from "../../api/queries";
import { useScope } from "../work/scope";
import { Async } from "../../ui/async";
import { Spark } from "../../ui/charts";
import { Avatar, Btn, Chip, Empty, Meter, Stat, StatRow, ViewHead } from "../../ui/primitives";
import { WoActions } from "../work/WoActions";
import { useCatalog } from "../projects/kit";

/** The prototype's page: tiles and the agent grid, nothing else. Conversations, the Console and the Operator view are their own pages. */
export function AtWork({ needs = 0, onInbox, onNew }: { needs?: number; onInbox?: () => void; onNew?: () => void } = {}) {
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
      <ViewHead title="Agents at work" kicker={scope.kicker} sub="Who is doing what right now, across the line." actions={onInbox || onNew ? <>
        {onInbox ? <Btn icon="chat" label={needs ? `Agent chats · ${needs} need you` : "Agent chats"} id="ws-at-inbox" onClick={onInbox} /> : null}
        {onNew ? <Btn kind="primary" icon="plus" label="New chat" id="ws-at-new" onClick={onNew} /> : null}
      </> : undefined} />
      <StatRow id="ws-stats">
        <Stat label="Agents active" value={String(active)} sub={`of ${agents.length}`} tone="info" />
        <Stat label="Running runs" value={String(running.length)} sub="work orders" tone="done" />
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
                  <div key={a.id} className="card">
                    <a className="aw-head" href={`#agents/${encodeURIComponent(a.id)}`} id={`ws-agent-${a.id}`}>
                    <div className="row">
                      <Avatar id={a.id} />
                      <div className="grow">
                        <h3>{a.name}</h3>
                        <div className="small muted" style={{ whiteSpace: "nowrap" }}>{a.model}</div>
                      </div>
                      <Chip text={jobs.length ? "working" : "idle"} cls={jobs.length ? "ok" : "plain"} />
                    </div>
                    </a>
                    {jobs.length ? (
                      jobs.slice(0, 3).map((w) => (
                        <div key={w.id} className="small">
                          <div className="wrap-text"><span className="mono">{w.id}</span>{" " + w.title}</div>
                          <div style={{ marginTop: 4 }}><Meter value={w.progress} max={100} label={`${w.id} progress`} /></div>
                          <div style={{ marginTop: 6 }}><WoActions wo={w.id} project={w.project} repo={w.repo} idPrefix="ws-at" /></div>
                        </div>
                      ))
                    ) : (
                      <div className="small muted">{`Waiting for work at ${stationName(a.station)}`}</div>
                    )}
                    <div className="row small muted">
                      <Spark values={a.spark} w={80} h={22} area={false} />
                      <span>{`success ${fmt.pct(a.evalScore)}`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty id="ws-agents-empty" title="No agents on the line" text="Agents appear here once they are assigned to a station." />
          )
        }
      </Async>
    </div>
  );
}
