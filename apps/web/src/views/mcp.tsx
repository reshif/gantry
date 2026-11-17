/**
 * MCP servers (spec 8.8, 12.4). Port of legacy/js/views/mcp.js against /api/v1/mcp/*: the registry (transport, URL, masked auth, health, tools with the
 * admin-set read or write class, sensitivity), the Add dialog with real tool discovery through the edge, scope by project, repo, agent, station and work
 * class, per-tool allow and deny, an effective-access checker and the usage log.
 * Not ported, on purpose: stdio servers (they run on the runner, outside the registry), the OAuth, mTLS and Vault auth modes (the edge injects a bearer
 * token or an API key header), the write-gate switch (write tools always need a pre-authorisation, so it is shown on and locked), the "gated" call
 * outcome (a write call without its pre-authorisation is denied) and every "simulated" label: discovery and the calls are real.
 */
import { useState } from "react";
import { useCan } from "../api/can";
import { useAgents, useMcpCalls, useMcpServers, useProjects } from "../api/queries";
import { Btn, Empty, Field, FilterBar, Panel, SearchBox, Select, Stat, StatRow, Table, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { AddMcp } from "./mcp/AddDialog";
import { Detail } from "./mcp/Detail";
import { Health, SENS, dec } from "./mcp/kit";
import { UsageTab } from "./mcp/Usage";

export default function McpView() {
  const ui = useUI();
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
  const [tab, setTab] = useState("registry");
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [health, setHealth] = useState("all");
  const [sens, setSens] = useState("all");
  const needle = q.trim().toLowerCase();
  const shown = servers.filter((m) => (health === "all" || (health === "disabled" ? m.enabled === false : m.enabled !== false && m.health === health)) && (sens === "all" || m.sensitivity === sens) && (!needle || `${m.name} ${m.url} ${m.transport}`.toLowerCase().includes(needle)));
  const current = servers.find((m) => m.id === sel) ?? null;
  const actorName = (id: string): string => actor(id).name;
  const notHealthy = servers.filter((m) => m.enabled === false || m.health !== "healthy").length;
  const writeTools = servers.reduce((n, m) => n + m.tools.filter((t) => t.write).length, 0);

  const registry = (
    <Async query={serversQ} what="MCP servers" id="mcp" empty={<Empty id="mcp-empty" title="No MCP servers yet" text="An MCP server gives agents tools: a tracker, docs or a database. Add one, then choose the projects, stations and agents that may use it." />}>
      {() => (
    current ? (
      <div className="stack">
        <div><Btn label="MCP servers" small kind="ghost" icon="arrow-left" id="mcp-back" onClick={() => setSel(null)} /></div>
        <Detail key={current.id} srv={current} cat={cat} projects={projects} agents={agents} repos={repos} calls={calls} actorName={actorName} onRemoved={() => setSel(null)} />
      </div>
    ) : (
      <Panel title="MCP servers" flush>
        <FilterBar label="Filter servers" count={`${shown.length} ${shown.length === 1 ? "server" : "servers"}`}>
          <SearchBox id="mcp-q" label="Search" placeholder="Search..." value={q} onChange={setQ} />
          <Field label="Health" htmlFor="mcp-f-health"><Select id="mcp-f-health" options={[{ value: "all", label: "All" }, { value: "healthy", label: "Healthy" }, { value: "degraded", label: "Degraded" }, { value: "failing", label: "Failing" }, { value: "offline", label: "Offline" }, { value: "disabled", label: "Disabled" }]} value={health} onChange={setHealth} /></Field>
          <Field label="Sensitivity" htmlFor="mcp-f-sens"><Select id="mcp-f-sens" options={[{ value: "all", label: "All" }, ...SENS]} value={sens} onChange={setSens} /></Field>
        </FilterBar>
        {shown.length ? (
          <Table>
            <thead><tr><th>Server</th><th>Health</th><th>Sensitivity</th><th className="r">Tools</th><th>Writes</th><th className="r">Agents</th></tr></thead>
            <tbody>
              {shown.map((m) => {
                const w = m.tools.filter((t) => t.write).length;
                return (
                  <tr key={m.id} className="row-link" id={`mcp-row-${m.id}`} onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; setSel(m.id); }}>
                    <td>
                      <button type="button" className="linkish mcp-name" id={`mcp-open-${m.id}`} onClick={() => setSel(m.id)}><b>{m.name}</b></button>
                      <div className="sub mono small">{m.url}</div>
                    </td>
                    <td><Health st={m.enabled === false ? "disabled" : m.health} /></td>
                    <td>{m.sensitivity}</td>
                    <td className="r">{m.tools.filter((t) => t.allowed).length}/{m.tools.length}</td>
                    <td>{w ? <span className="chip ok">gated</span> : <span className="chip plain">read only</span>}</td>
                    <td className="r">{m.agents === "all" ? "all" : m.agents.length}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : <Empty title="No server matches" text="Change the search or filters." />}
      </Panel>
    )
      )}
    </Async>
  );

  return (
    <div className="view cx mcp-view">
      <ViewHead
        title="MCP servers"
        sub="External tools agents may call, with write gates and per-agent scope."
        actions={<Btn label="Add server" kind="primary" icon="plus" id="mcp-add" guard={perm} onClick={() => ui.open((close) => <AddMcp close={close} onAdded={(id) => { setSel(id); setTab("registry"); }} />)} />}
      />
      <StatRow id="mcp-stats">
        <Stat label="Servers" value={qState(serversQ, (d) => String(d.length))} />
        <Stat label="Healthy" value={qState(serversQ, () => String(servers.filter((m) => m.enabled !== false && m.health === "healthy").length))} tone={notHealthy ? "wait" : "done"} sub={notHealthy ? `${notHealthy} not healthy` : undefined} />
        <Stat label="Tools exposed" value={qState(serversQ, () => String(servers.reduce((n, m) => n + m.tools.filter((t) => t.allowed).length, 0)))} sub={`of ${servers.reduce((n, m) => n + m.tools.length, 0)}`} />
        <Stat label="Calls logged" value={qState(callsQ, () => String(calls.length))} sub={`${writeTools} write tools`} />
      </StatRow>
      <Tabs idPrefix="mcp-tab" items={[{ id: "registry", label: "Registry", count: servers.length }, { id: "usage", label: "Usage log", count: calls.length }]} active={tab} onChange={setTab} />
      <div id="mcp-tab-panel" role="tabpanel" aria-labelledby={`mcp-tab-${tab}`}>
        {tab === "usage" ? (
          <Async query={callsQ} what="the MCP usage log" id="mcp-usage">{() => <UsageTab calls={calls} servers={servers} agents={agents} projects={projects} actorName={actorName} />}</Async>
        ) : registry}
      </div>
    </div>
  );
}
