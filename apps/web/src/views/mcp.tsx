/**
 * MCP servers (spec 8.8, 12.4). Port of legacy/js/views/mcp.js against /api/v1/mcp/*: the registry (transport, URL, masked auth, health, tools with the
 * admin-set read or write class, sensitivity), the Add dialog with real tool discovery through the edge, scope by project, repo, agent, station and work
 * class, per-tool allow and deny, an effective-access checker and the usage log.
 * Not ported, on purpose: stdio servers (they run on the runner, outside the registry), the OAuth, mTLS and Vault auth modes (the edge injects a bearer
 * token or an API key header), the write-gate switch (write tools always need a pre-authorisation, so it is shown on and locked), the "gated" call
 * outcome (a write call without its pre-authorisation is denied) and every "simulated" label: discovery and the calls are real.
 */
import { useState } from "react";
import { DAY } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, useMcpCalls, useMcpServers, useProjects } from "../api/queries";
import { Btn, Empty, Field, FilterBar, Panel, SearchBox, Select, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { useCatalog } from "./projects/kit";
import { useAllRepos } from "./govern/data";
import { AddMcp } from "./mcp/AddDialog";
import { Detail } from "./mcp/Detail";
import { Health, SENS, SensChip, dec, scopeText } from "./mcp/kit";
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
  const shown = servers.filter((m) => (health === "all" || (health === "disabled" ? m.enabled === false : m.health === health)) && (sens === "all" || m.sensitivity === sens) && (!needle || `${m.name} ${m.url} ${m.transport}`.toLowerCase().includes(needle)));
  const current = servers.find((m) => m.id === sel) ?? servers[0] ?? null;
  const actorName = (id: string): string => actor(id).name;
  const day = calls.filter((u) => u.at > Date.now() - DAY).length;
  const writeTools = servers.reduce((n, m) => n + m.tools.filter((t) => t.write).length, 0);

  const registry = (
    <Async query={serversQ} what="MCP servers" id="mcp" empty={<Empty id="mcp-empty" title="No MCP servers yet" text="An MCP server gives agents tools: a tracker, docs or a database. Add one, then choose the projects, stations and agents that may use it." />}>
      {() => (
    <div className="mcp-split">
      <Panel title="Registry" flush>
        <FilterBar label="Filter servers" count={`${shown.length} of ${servers.length}`}>
          <SearchBox id="mcp-q" label="Search" placeholder="Search by name or address" value={q} onChange={setQ} />
          <div className="filters">
            <Field label="Health" htmlFor="mcp-f-health"><Select id="mcp-f-health" options={[{ value: "all", label: "Any" }, { value: "healthy", label: "Healthy" }, { value: "degraded", label: "Degraded" }, { value: "failing", label: "Failing" }, { value: "offline", label: "Offline" }, { value: "disabled", label: "Disabled" }]} value={health} onChange={setHealth} /></Field>
            <Field label="Sensitivity" htmlFor="mcp-f-sens"><Select id="mcp-f-sens" options={[{ value: "all", label: "Any" }, ...SENS]} value={sens} onChange={setSens} /></Field>
          </div>
        </FilterBar>
        {shown.length ? <div className="table-scroll">
          <table className="table table-compact mcp-reg">
            <thead><tr><th>Server and scope</th><th>Health</th><th>Tools</th><th>Sensitivity</th></tr></thead>
            <tbody>
              {shown.map((m) => {
                const w = m.tools.filter((t) => t.write).length;
                const den = m.tools.filter((t) => !t.allowed).length;
                return (
                  <tr key={m.id} className={`row-link${m.id === current?.id ? " is-selected" : ""}`} id={`mcp-row-${m.id}`} onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; setSel(m.id); }}>
                    <td>
                      <button type="button" className="linkish mcp-name" id={`mcp-open-${m.id}`} onClick={() => setSel(m.id)}>{m.name}</button>
                      <div className="mono small muted mcp-url">{m.transport} · {m.url}</div>
                      <div className="small muted">{m.auth} <span className="mono">{m.authMask}</span></div>
                      <div className="small mcp-scopeline">{`${scopeText(m.projects, "projects")} · ${scopeText(m.repos, "repos")} · ${scopeText(m.agents, "agents")} · ${scopeText(m.stations, "stations")} · ${scopeText(m.classes ?? "all", "classes")}`}</div>
                    </td>
                    <td><Health st={m.health} />{m.enabled === false ? <div className="small neg">disabled</div> : null}</td>
                    <td className="mono small mcp-tc">{`${m.tools.length - w} R · ${w} W`}{den ? <div className="neg">{den} denied</div> : null}</td>
                    <td><SensChip s={m.sensitivity} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div> : <Empty title="No server matches" text="Change the search or filters." />}
      </Panel>
      {current ? <Detail key={current.id} srv={current} cat={cat} projects={projects} agents={agents} repos={repos} calls={calls} actorName={actorName} onRemoved={() => setSel(null)} /> : null}
    </div>
      )}
    </Async>
  );

  return (
    <div className="view cx mcp-view">
      <ViewHead
        title="MCP servers"
        sub="Tools agents may call, and exactly where. Scope by project, repo, agent, station and work class; deny single tools; write tools need a pre-authorisation at the station. The edge makes every connection and holds every credential."
        actions={<Btn label="Add server" kind="primary" icon="plus" id="mcp-add" guard={perm} onClick={() => ui.open((close) => <AddMcp close={close} onAdded={(id) => { setSel(id); setTab("registry"); }} />)} />}
      />
      <StatRow id="mcp-stats">
        <Stat label="Servers" value={qState(serversQ, (d) => String(d.length))} sub="in the registry" />
        <Stat label="Not healthy" value={qState(serversQ, (d) => String(d.filter((m) => m.health !== "healthy").length))} sub="degraded, failing or disabled" tone={servers.some((m) => m.health !== "healthy") ? "wait" : undefined} />
        <Stat label="Write tools" value={qState(serversQ, () => String(writeTools))} sub="across all servers" />
        <Stat label="Calls 24h" value={qState(callsQ, () => String(day))} sub="from agents" />
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
