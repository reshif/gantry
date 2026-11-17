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
import { Btn, Empty, FilterBar, SearchBox, Select, Stat, StatRow, Tabs, ViewHead } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { useActors } from "../ui/actors";
import { Icon } from "../ui/Icon";
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
  const shown = servers.filter((m) => (health === "all" || (health === "disabled" ? m.enabled === false : m.enabled !== false && m.health === health)) && (sens === "all" || m.sensitivity === sens) && (!needle || `${m.name} ${m.url} ${m.transport}`.toLowerCase().includes(needle)));
  const current = servers.find((m) => m.id === sel) ?? servers[0] ?? null;
  const actorName = (id: string): string => actor(id).name;
  const day = calls.filter((u) => u.at > Date.now() - DAY).length;
  const notHealthy = servers.filter((m) => m.enabled === false || m.health !== "healthy").length;
  const writeTools = servers.reduce((n, m) => n + m.tools.filter((t) => t.write).length, 0);

  const registry = (
    <Async query={serversQ} what="MCP servers" id="mcp" empty={<Empty id="mcp-empty" title="No MCP servers yet" text="An MCP server gives agents tools: a tracker, docs or a database. Add one, then choose the projects, stations and agents that may use it." />}>
      {() => (
    <div className="stack">
      {servers.some((m) => m.tools.some((t) => t.changed)) ? (
        <div className="banner warn" role="note">
          <Icon name="alert" />
          <div className="grow">{servers.filter((m) => m.tools.some((t) => t.changed)).map((m) => <span key={m.id}><b>{m.name}</b> changed a tool definition. It stays paused until re-approved. </span>)}</div>
        </div>
      ) : null}
      <FilterBar label="Filter servers" count={`${shown.length} of ${servers.length}`}>
        <SearchBox id="mcp-q" label="Search" placeholder="Search servers" value={q} onChange={setQ} />
        <Select id="mcp-f-health" aria-label="Health" options={[{ value: "all", label: "Health: all" }, { value: "healthy", label: "Healthy" }, { value: "degraded", label: "Degraded" }, { value: "failing", label: "Failing" }, { value: "offline", label: "Offline" }, { value: "disabled", label: "Disabled" }]} value={health} onChange={setHealth} />
        <Select id="mcp-f-sens" aria-label="Sensitivity" options={[{ value: "all", label: "Sensitivity: all" }, ...SENS]} value={sens} onChange={setSens} />
      </FilterBar>
      {shown.length ? (
        <div className="grid g2" id="mcp-registry">
          {shown.map((m) => {
            const w = m.tools.filter((t) => t.write).length;
            const den = m.tools.filter((t) => !t.allowed).length;
            return (
              <section key={m.id} className={`card${m.id === current?.id ? " is-selected" : ""}`} id={`mcp-row-${m.id}`}>
                <div className="card-h">
                  <div style={{ minWidth: 0 }}>
                    <h3 className="ell">{m.name}</h3>
                    <div className="hint mono ell">{m.url}</div>
                  </div>
                  <Health st={m.health} />
                </div>
                <div className="card-b stack" style={{ gap: 12 }}>
                  <div className="row">
                    <span className="tag">{m.auth}</span>
                    <SensChip s={m.sensitivity} />
                    {m.enabled === false ? <span className="chip idle">disabled</span> : null}
                    <span className="dim">{m.tools.length} tools · {`${m.tools.length - w} R · ${w} W`}{den ? ` · ${den} denied` : ""}</span>
                  </div>
                  <div className="row">
                    {m.tools.map((t) => <span key={t.name} className="tag" style={{ ...(t.write ? { borderColor: "var(--warn)", color: "var(--warn)" } : {}), ...(t.allowed ? {} : { textDecoration: "line-through" }) }}>{t.name}</span>)}
                  </div>
                  <div className="row spread">
                    <span className="dim small">{`${scopeText(m.projects, "projects")} · ${scopeText(m.repos, "repos")} · ${scopeText(m.agents, "agents")} · ${scopeText(m.stations, "stations")} · ${scopeText(m.classes ?? "all", "classes")}`}</span>
                    <Btn label="Manage tools" small id={`mcp-open-${m.id}`} onClick={() => { setSel(m.id); requestAnimationFrame(() => document.getElementById("mcp-detail")?.scrollIntoView?.({ behavior: "smooth", block: "start" })); }} />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      ) : <Empty title="No server matches" text="Change the search or filters." />}
      {current ? <div id="mcp-detail"><Detail key={current.id} srv={current} cat={cat} projects={projects} agents={agents} repos={repos} calls={calls} actorName={actorName} onRemoved={() => setSel(null)} /></div> : null}
    </div>
      )}
    </Async>
  );

  return (
    <div className="view cx mcp-view">
      <ViewHead
        kicker="Connect"
        title="MCP servers"
        sub="Tool servers agents can call. Write tools need a gate; changed definitions need re-approval."
        actions={<Btn label="Add server" kind="primary" icon="plus" id="mcp-add" guard={perm} onClick={() => ui.open((close) => <AddMcp close={close} onAdded={(id) => { setSel(id); setTab("registry"); }} />)} />}
      />
      <StatRow id="mcp-stats">
        <Stat label="Servers" value={qState(serversQ, (d) => String(d.length))} sub="in the registry" />
        <Stat label="Not healthy" value={qState(serversQ, () => String(notHealthy))} sub={notHealthy ? "degraded, failing, offline or disabled" : "all healthy"} tone={serversQ.data && notHealthy ? "wait" : undefined} />
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
