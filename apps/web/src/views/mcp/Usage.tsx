/** The usage log (prototype "Recent tool calls"): every MCP call with its server, tool, agent, project, outcome and latency (spec 12.4). */
import type { McpServer, McpUsage, Project } from "@gantry/domain";
import { Panel } from "../../ui/primitives";
import { ListView, ago, healthTone } from "../connect/kit";

const OUTCOMES = ["ok", "gated", "denied", "error", "allowed"];

export function UsageTab({ calls, servers, projects, actorName }: { calls: McpUsage[]; servers: McpServer[]; projects: Project[]; actorName: (id: string) => string }) {
  return (
    <Panel title="Recent tool calls" flush id="mcp-usage-panel">
      <ListView<McpUsage>
        id="mcpu" noun="call" rows={calls} rowKey={(u) => String(u.id ?? `${u.at}-${u.server}-${u.tool}`)}
        text={(u) => `${u.server} ${u.tool} ${u.agent ?? ""}`}
        filters={[
          { key: "outcome", label: "Outcome", options: OUTCOMES },
          { key: "server", label: "Server", options: servers.map((m) => [m.id, m.name] as [string, string]) },
        ]}
        columns={[
          { key: "at", label: "When", sort: (u) => u.at, render: (u) => ago(u.at) },
          { key: "server", label: "Server", render: (u) => u.server },
          { key: "tool", label: "Tool", render: (u) => <span className="mono">{u.tool}</span> },
          { key: "agent", label: "Agent", render: (u) => (u.agent ? actorName(u.agent).replace(" (agent)", "") : "unknown") },
          { key: "project", label: "Project", render: (u) => projects.find((p) => p.id === u.project)?.name ?? u.project ?? "\u2014" },
          { key: "outcome", label: "Outcome", render: (u) => <span className={`chip ${healthTone(u.outcome === "ok" ? "ok" : u.outcome === "gated" || u.outcome === "allowed" ? "warn" : "bad")}`} title={u.reason || undefined}>{u.outcome}</span> },
          { key: "ms", label: "Latency", align: "end", sort: (u) => u.ms, render: (u) => <span className="num">{u.ms} ms</span> },
        ]}
      />
    </Panel>
  );
}
