/**
 * MCP servers (spec 8.8, 12.4), in the Blueprint prototype's layout: a registry and a usage log (tabs in the URL), and one page per server at
 * #mcp/<id> with Overview, Tools, Scope, Access check and Recent calls tabs. Real behaviour kept: the Register dialog discovers tools through the
 * edge, scope by project, repo, agent, station and work class, per-tool allow and class, the effective-access check, re-approval and removal.
 * Not offered, on purpose: stdio servers (they run on the runner), OAuth / mTLS / Vault auth (the edge injects a bearer token or an API key
 * header), a write-gate switch (write tools always need a pre-authorisation, so it is shown on and locked) and the "gated" call outcome
 * (a write call without its pre-authorisation is denied).
 */
import { useCan } from "../api/can";
import { useAgents, useMcpCalls, useMcpServers, useProjects } from "../api/queries";
import { Btn, Empty, Panel, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { useHash, hashFor, navigate } from "../lib/router";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { AddMcp } from "./mcp/AddDialog";
import { Detail } from "./mcp/Detail";
import { dec } from "./mcp/kit";
import { UsageTab } from "./mcp/Usage";
import { ListView, healthTone, useTab } from "./connect/kit";
import type { McpServer } from "@gantry/domain";

const down = (m: McpServer): boolean => m.enabled !== false && (m.health === "failing" || m.health === "offline" || (m.health as string) === "down");

export default function McpView() {
  const ui = useUI();
  const hash = useHash();
  const perm = dec(useCan("mcp.edit"));
  const serversQ = useMcpServers();
  const servers = serversQ.data ?? [];
  const callsQ = useMcpCalls({ limit: 500 });
  const calls = Array.isArray(callsQ.data) ? callsQ.data : callsQ.data?.items ?? [];
  const projects = useProjects().data ?? [];
  const agents = useAgents().data ?? [];
  const cat = useCatalog();
  const { repos } = useAllRepos();
  const actor = useActors();
  const [tab, setTab] = useTab(["registry", "usage"]);
  const actorName = (id: string): string => actor(id).name;

  if (hash.param) {
    return (
      <Async query={serversQ} what="MCP servers" id="mcp">
        {() => <Detail srv={servers.find((m) => m.id === hash.param) ?? null} cat={cat} projects={projects} agents={agents} repos={repos} calls={calls} actorName={actorName} />}
      </Async>
    );
  }

  const exposed = servers.reduce((n, m) => n + m.tools.filter((t) => t.allowed).length, 0);
  const total = servers.reduce((n, m) => n + m.tools.length, 0);
  const gated = calls.filter((u) => u.outcome === "gated").length;
  const stateOf = (m: McpServer): string => (m.enabled === false ? "disabled" : m.health);

  const registry = (
    <Async query={serversQ} what="MCP servers" id="mcp" empty={<Empty id="mcp-empty" title="No MCP servers yet" text="An MCP server gives agents tools: a tracker, docs or a database. Register one, then choose the projects, stations and agents that may use it." />}>
      {() => (
        <Panel title="MCP servers" flush id="mcp-registry">
          <ListView<McpServer>
            id="mcp" noun="server" rows={servers} rowKey={(m) => m.id} rowId={(m) => `mcp-row-${m.id}`} onRow={(m) => navigate("mcp", m.id)}
            text={(m) => `${m.name} ${m.url} ${m.transport}`}
            filters={[
              { key: "health", label: "Health", options: ["healthy", "degraded", "down", "disabled"], test: (m, v) => (v === "disabled" ? m.enabled === false : v === "down" ? down(m) : m.enabled !== false && m.health === v) },
              { key: "sensitivity", label: "Sensitivity", options: ["public", "internal", "confidential", "restricted"] },
            ]}
            columns={[
              { key: "n", label: "Server", sort: (m) => m.name.toLowerCase(), render: (m) => <div><a className="pri" id={`mcp-open-${m.id}`} href={hashFor("mcp", m.id)}>{m.name}</a><span className="sub mono">{m.url}</span></div> },
              { key: "h", label: "Health", sort: (m) => stateOf(m), render: (m) => <span className={`chip ${healthTone(stateOf(m))}`}>{stateOf(m)}</span> },
              { key: "s", label: "Sensitivity", render: (m) => m.sensitivity },
              { key: "t", label: "Tools", align: "end", sort: (m) => m.tools.length, render: (m) => `${m.tools.filter((t) => t.allowed).length}/${m.tools.length}` },
              { key: "w", label: "Writes", render: (m) => (m.writeGate ? <span className="chip ok">gated</span> : <span className="chip warn">open</span>) },
              { key: "a", label: "Agents", align: "end", render: (m) => (m.agents === "all" ? "all" : m.agents.length) },
            ]}
          />
        </Panel>
      )}
    </Async>
  );

  return (
    <div className="view cx mcp-view">
      <ViewHead
        title="MCP servers" kicker="All lines"
        sub="External tools agents may call, with write gates and per-agent scope."
        actions={<Btn label="Register server" kind="primary" icon="plus" id="mcp-add" guard={perm} onClick={() => ui.open((close) => <AddMcp close={close} onAdded={(id) => navigate("mcp", id)} />)} />}
      />
      <StatRow id="mcp-stats">
        <Stat label="Servers" value={qState(serversQ, (d) => String(d.length))} tone="info" />
        <Stat label="Healthy" value={qState(serversQ, () => String(servers.filter((m) => m.enabled !== false && m.health === "healthy").length))} tone="done" />
        <Stat label="Tools exposed" value={qState(serversQ, () => String(exposed))} sub={`of ${total}`} />
        <Stat label="Calls logged" value={qState(callsQ, () => String(calls.length))} sub={`${gated} gated`} tone="wait" />
      </StatRow>
      <Tabs idPrefix="mcp-tab" items={[{ id: "registry", label: "Registry", count: servers.length }, { id: "usage", label: "Usage log", count: calls.length }]} active={tab} onChange={setTab} />
      <div id="mcp-tab-panel" role="tabpanel" aria-labelledby={`mcp-tab-${tab}`}>
        {tab === "usage" ? (
          <Async query={callsQ} what="the MCP usage log" id="mcp-usage">{() => <UsageTab calls={calls} servers={servers} projects={projects} actorName={actorName} />}</Async>
        ) : registry}
      </div>
    </div>
  );
}
