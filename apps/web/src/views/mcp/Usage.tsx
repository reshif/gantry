/** The usage log (legacy usageTable and usageTab): every MCP call with its work order, agent, tool, outcome and latency (spec 12.4). */
import { useState } from "react";
import { fmt, type McpServer, type McpUsage, type Project, type Agent } from "@gantry/domain";
import { Btn, Empty, Field, Panel, Select } from "../../ui/primitives";
import { OUTCOME, Rw } from "./kit";

export function UsageTable({ list, compact, servers, projects, actorName }: { list: McpUsage[]; compact?: boolean; servers: McpServer[]; projects: Project[]; actorName: (id: string) => string }) {
  return (
    <table className="table table-compact mcp-usage">
      <thead>
        <tr><th>Time (IST)</th>{compact ? null : <th>Server</th>}<th>Tool</th><th>Agent</th><th>Project</th><th>Outcome</th><th className="num">ms</th></tr>
      </thead>
      <tbody>
        {list.map((u, i) => {
          const srv = servers.find((s) => s.id === u.server);
          const t = srv?.tools.find((x) => x.name === u.tool);
          const oc = OUTCOME[u.outcome] ?? OUTCOME.error!;
          return (
            <tr key={u.id ?? `${u.at}-${i}`} title={u.reason || undefined}>
              <td className="mono">{fmt.istDate(u.at)} {fmt.ist(u.at)}</td>
              {compact ? null : <td>{srv ? srv.name : `${u.server} (removed)`}</td>}
              <td>{t ? <Rw write={t.write} /> : null} <span className="mono">{u.tool}</span></td>
              <td>{u.agent ? actorName(u.agent).replace(" (agent)", "") : "unknown"}</td>
              <td>{projects.find((p) => p.id === u.project)?.key ?? u.project}</td>
              <td><span className={`outcome o-${oc.cls}`}>{oc.text}</span></td>
              <td className="num mono">{String(u.ms)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function UsageTab({ calls, servers, agents, projects, actorName }: { calls: McpUsage[]; servers: McpServer[]; agents: Agent[]; projects: Project[]; actorName: (id: string) => string }) {
  const [f, setF] = useState({ server: "all", agent: "all", project: "all", outcome: "all" });
  const [limit, setLimit] = useState(50);
  const list = calls.filter((u) => (f.server === "all" || u.server === f.server) && (f.agent === "all" || u.agent === f.agent) && (f.project === "all" || u.project === f.project) && (f.outcome === "all" || u.outcome === f.outcome));
  const by: Record<string, number> = {};
  for (const u of list) by[u.server] = (by[u.server] ?? 0) + 1;
  const max = Math.max(1, ...Object.values(by));
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <div className="form-grid">
      <div className="filters">
        <Field label="Server" htmlFor="mcp-f-server"><Select id="mcp-f-server" options={[{ value: "all", label: "All servers" }, ...servers.map((m) => ({ value: m.id, label: m.name }))]} value={f.server} onChange={set("server")} /></Field>
        <Field label="Agent" htmlFor="mcp-f-agent"><Select id="mcp-f-agent" options={[{ value: "all", label: "All agents" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} value={f.agent} onChange={set("agent")} /></Field>
        <Field label="Project" htmlFor="mcp-f-project"><Select id="mcp-f-project" options={[{ value: "all", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} value={f.project} onChange={set("project")} /></Field>
        <Field label="Outcome" htmlFor="mcp-f-outcome"><Select id="mcp-f-outcome" options={[{ value: "all", label: "All" }, { value: "ok", label: "Ok" }, { value: "allowed", label: "Running" }, { value: "error", label: "Error" }, { value: "denied", label: "Denied" }]} value={f.outcome} onChange={set("outcome")} /></Field>
      </div>
      <div className="mcp-bars" role="list" aria-label="Calls by server">
        {Object.keys(by).map((k) => (
          <div className="mcp-bar" role="listitem" key={k}>
            <span className="small mcp-bar-l">{servers.find((m) => m.id === k)?.name ?? k}</span>
            <span className="mcp-bar-t"><span style={{ width: `${((by[k]! / max) * 100).toFixed(0)}%` }} /></span>
            <span className="mono small">{String(by[k])}</span>
          </div>
        ))}
      </div>
      <Panel flush>
        {list.length ? <div className="table-scroll" data-keep-scroll="mcp-usage"><UsageTable list={list.slice(0, limit)} servers={servers} projects={projects} actorName={actorName} /></div> : <Empty title="No calls match" text="Change the filters." />}
      </Panel>
      {list.length > limit ? <div className="more"><Btn label="Show 50 more" id="mcp-more" onClick={() => setLimit(limit + 50)} /></div> : null}
      <p className="footnote">Every call is logged with its work order, agent, tool, a hash of its arguments and the outcome. The edge reports the outcome once the server has answered; a call still running shows as running. A write call without its pre-authorisation is denied and never reaches the server.</p>
    </div>
  );
}
