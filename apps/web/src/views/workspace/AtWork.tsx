/**
 * Agents at work (#workspace, no conversation open): who is doing what right now, as the Blueprint prototype draws it. Stat tiles and a grid of
 * agent cards. Conversations (the inbox and every thread) are one click away and keep their own pane.
 */
import type { ReactNode } from "react";
import { fmt } from "@gantry/domain";
import { useAgents, useHome, useWorkOrders } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";
import { Async } from "../../ui/async";
import { Spark } from "../../ui/charts";
import { Avatar, Chip, Empty, Meter, Stat, StatRow, ViewHead } from "../../ui/primitives";
import { useCatalog } from "../projects/kit";
import type { HomeFull } from "../home/data";

export function AtWork({ needs, actions }: { needs: number; actions: ReactNode }) {
  const agentsQ = useAgents();
  const prefs = usePrefs();
  const wosQ = useWorkOrders(prefs.project);
  const cat = useCatalog();
  const home: HomeFull | undefined = useHome().data as HomeFull | undefined;
  const agents = agentsQ.data ? agentsQ.data.filter((a) => a.station) : [];
  const raw = wosQ.data;
  const wos = Array.isArray(raw) ? raw : raw ? raw.items : [];
  const running = wos.filter((w) => w.state === "running");
  const agentOf = (w: { station: number }): string | undefined => cat?.stations[w.station]?.agent;
  const jobsOf = (id: string) => running.filter((w) => agentOf(w) === id);
  const active = agents.filter((a) => jobsOf(a.id).length).length;
  const tokens = running.reduce((n, w) => n + (w.history.at(-1)?.tokens ?? 0), 0);
  const stationName = (id: string | null): string => cat?.stations.find((s) => s.id === id)?.name ?? "its station";
  return (
    <div className="view ws-atwork">
      <ViewHead title="Agents at work" sub={needs ? `Who is doing what right now. ${needs} conversation${needs === 1 ? "" : "s"} need you.` : "Who is doing what right now, across the line."} actions={actions} />
      <StatRow id="ws-stats">
        <Stat label="Agents active" value={String(active)} sub={`of ${agents.length}`} tone="done" />
        <Stat label="Running runs" value={String(home?.sections?.motion?.running ?? running.length)} sub="work orders" />
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
                      <div className="grow">
                        <h3>{a.name}</h3>
                        <div className="small muted">{a.model}</div>
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
                      <Spark values={a.spark} w={80} h={22} />
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
    </div>
  );
}
