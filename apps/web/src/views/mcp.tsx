/**
 * MCP servers (spec 8.8, 12.4), the Control Room screen: head with Register server, a banner when a server changed a tool definition
 * (Review change opens the re-approval), a search with its count, and one card per server (auth, sensitivity, tools and write tools, tool tags,
 * Agents, Manage tools). Manage tools opens the server drawer (not in the URL, like the prototype). The usage log of every call stays behind the Usage log button (`?view=usage`).
 * Real data: /mcp/servers and /mcp/usage; discovery, scope and the access check are the registry's own.
 */
import type { McpServer } from "@gantry/domain";
import { useCan } from "../api/can";
import { useAgents, useMcpCalls, useMcpServers, useProjects } from "../api/queries";
import { Btn, FilterBar, Segmented, SearchBox } from "../ui/primitives";
import { Async } from "../ui/async";
import { Page, CrIcon } from "../ui/cr";
import { useActors } from "../ui/actors";
import { useUI } from "../ui/overlay-context";
import { AddMcp } from "./mcp/AddDialog";
import { ServerDrawer } from "./mcp/Drawer";
import { ScopeDialog } from "./mcp/Scope";
import { ReapproveDialog } from "./mcp/Reapprove";
import { Health, authLabel, dec } from "./mcp/kit";
import { UsageTab } from "./mcp/Usage";
import { oneOf, useUrlState } from "./connect/kit";

export default function McpView() {
  const ui = useUI();
  const perm = dec(useCan("mcp.edit"));
  const serversQ = useMcpServers();
  const servers = serversQ.data ?? [];
  const callsQ = useMcpCalls({ limit: 500 });
  const calls = Array.isArray(callsQ.data) ? callsQ.data : callsQ.data?.items ?? [];
  const projects = useProjects().data ?? [];
  const agents = useAgents().data ?? [];
  const actor = useActors();
  const url = useUrlState({ view: "registry", q: "", server: "" });
  const view = oneOf(url.v.view, ["registry", "usage", "scope"] as const, "registry");

  const openServer = (id: string): void => {
    ui.drawer.open(`mcp:${id}`, (close) => <ServerDrawer id={id} close={close} onScope={() => { close(); url.set({ view: "scope", server: id }); }} />);
  };

  const needle = url.v.q.trim().toLowerCase();
  const shown = servers.filter((m) => !needle || `${m.name} ${m.url}`.toLowerCase().includes(needle));
  const changed = servers.filter((m) => m.tools.some((t) => t.changed) || (m.enabled === false && m.disabledReason));
  const agentNames = (m: McpServer): string => (m.agents === "all" ? "all agents" : m.agents.map((a) => agents.find((x) => x.id === a)?.name ?? a).join(", ") || "none");

  const registry = (
    <Async query={serversQ} what="MCP servers" id="mcp" empty={(
      <div className="card"><div className="empty"><div className="ei"><CrIcon name="inbox" /></div><h3>No MCP servers yet</h3><p>An MCP server gives agents tools: a tracker, docs or a database. Register one, then choose the projects, stations and agents that may use it.</p></div></div>
    )}>
      {() => (
        <>
          {changed.map((m) => (
            <div className="banner warn" role="note" key={m.id} id={`mcp-changed-${m.id}`}>
              <CrIcon name="warn" />
              <div className="grow"><b>{m.name}</b> changed a tool definition. It stays paused until re-approved.</div>
              <Btn label="Review change" small id={`mcp-review-${m.id}`} guard={perm} onClick={() => ui.open((close) => <ReapproveDialog srv={m} close={close} />)} />
            </div>
          ))}
          <FilterBar label="Filter servers" count={`${shown.length} of ${servers.length}`} actions={(
            <>
              {url.v.q ? <Btn label="Clear" small kind="ghost" id="mcp-clear" onClick={() => url.clear("view", "server")} /> : null}
            </>
          )}>
            <SearchBox id="mcp-q" label="Search servers" placeholder="Search servers" value={url.v.q} onChange={(q) => url.set({ q })} />
          </FilterBar>
          {shown.length ? (
            <div className="grid g2" id="mcp-registry">
              {shown.map((m) => {
                const w = m.tools.filter((t) => t.write).length;
                return (
                  <section key={m.id} className="card" id={`mcp-row-${m.id}`}>
                    <div className="card-h">
                      <div style={{ minWidth: 0 }}>
                        <h3 className="ell">{m.name}</h3>
                        <div className="hint mono ell">{m.url}</div>
                      </div>
                      <Health st={m.enabled === false ? "disabled" : m.health} />
                    </div>
                    <div className="card-b stack" style={{ gap: 12 }}>
                      <div className="row">
                        <span className="tag">{authLabel(m)}</span>
                        <span className={`chip ${m.sensitivity === "restricted" ? "bad" : "idle"} plain`}>{m.sensitivity}</span>
                        <span className="dim">{m.tools.length} tools, {w} write</span>
                      </div>
                      <div className="row">
                        {m.tools.map((t) => <span key={t.name} className="tag" style={{ ...(t.write ? { borderColor: "var(--warn)", color: "var(--warn)" } : {}), ...(t.allowed ? {} : { textDecoration: "line-through" }) }}>{t.name}</span>)}
                      </div>
                      <div className="row spread">
                        <span className="dim" style={{ fontSize: 12 }}>Agents: {agentNames(m)}</span>
                        <Btn label="Manage tools" small id={`mcp-open-${m.id}`} onClick={() => openServer(m.id)} />
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          ) : <div className="grid g3" id="mcp-none" />}
        </>
      )}
    </Async>
  );

  return (
    <Page
      eyebrow="Connect" title="MCP servers" sub="Tool servers agents can call. Write tools need a gate; changed definitions need re-approval." cls="mcp-view"
      acts={<Btn label="Register server" kind="primary" icon="plus" id="mcp-add" guard={perm} onClick={() => ui.open((close) => <AddMcp close={close} />)} />}
    >
      <Segmented name="mcp-view" label="View" value={view === "usage" ? "usage" : "registry"} onChange={(v) => url.set({ view: v, server: "" })} items={[{ id: "registry", label: "Registry" }, { id: "usage", label: "Usage log" }]} />
      {view === "scope" && url.v.server ? <ScopeDialog id={url.v.server} close={() => url.set({ view: "registry", server: "" })} /> : null}
      {view === "usage" ? (
        <>
          <div className="row" style={{ margin: "12px 0" }}><span className="dim">Usage log: {calls.length} calls</span></div>
          <Async query={callsQ} what="the MCP usage log" id="mcp-usage">{() => <UsageTab calls={calls} servers={servers} agents={agents} projects={projects} actorName={(id) => actor(id).name} />}</Async>
        </>
      ) : registry}
    </Page>
  );
}
