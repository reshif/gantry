/** The MCP server drawer, in the prototype's anatomy: URL, Auth, Health, a Tools card (name, Write or Read only, allow switch) and Refresh definitions. Settings, scope and the access check follow in a disclosure. */
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useAgents, useMcpCalls, useMcpServers, useProjects } from "../../api/queries";
import { useActors } from "../../ui/actors";
import { useCatalog } from "../projects/kit";
import { useAllRepos } from "../govern/data";
import { Btn, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { CrDrawer, Kv } from "../connect/kit";
import { Detail } from "./Detail";
import { Health, authLabel, dec } from "./kit";

export function ServerDrawer({ id, close }: { id: string; close: () => void }) {
  const ui = useUI();
  const srv = (useMcpServers().data ?? []).find((m) => m.id === id);
  const callsQ = useMcpCalls({ limit: 500 });
  const calls = Array.isArray(callsQ.data) ? callsQ.data : callsQ.data?.items ?? [];
  const projects = useProjects().data ?? [];
  const agents = useAgents().data ?? [];
  const cat = useCatalog();
  const { repos } = useAllRepos();
  const actor = useActors();
  const actorName = (x: string): string => actor(x).name;
  const perm = dec(useCan("mcp.edit"));
  if (!srv) return null;
  const v = srv.version !== undefined ? { ifMatch: srv.version } : undefined;
  return (
    <CrDrawer
      eyebrow="MCP server" title={srv.name} close={close}
      foot={(
        <>
          <Btn label="Refresh definitions" id="mcp-d-refresh" guard={perm} onClick={() => { ui.toast(`Refreshing ${srv.name}…`, "info"); void ops.rediscoverMCP(srv.id, v).then((r) => ui.toast(r.ok ? r.msg : r.msg, r.ok ? "ok" : "error")); }} />
          <Btn label="Done" kind="primary" id="mcp-d-done" onClick={close} />
        </>
      )}
    >
      <Kv rows={[["URL", <span key="u" className="mono">{srv.url}</span>], ["Auth", authLabel(srv)], ["Health", <Health key="h" st={srv.health} />]]} />
      <div className="card">
        <div className="card-h"><h3>Tools</h3></div>
        <div className="card-b flush">
          {srv.tools.map((t, i) => (
            <div className="setrow" key={t.name}>
              <div className="tx"><b className="mono">{t.name}</b><span>{t.write ? "Write tool: runs behind a gate" : "Read only"}</span></div>
              <Toggle id={`mcp-dtool-${i}`} checked={t.allowed} label={`${t.name} allowed`} decision={perm} onChange={(on) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, allowed: on }] }, v).then((r) => ui.toast(r.ok ? `${t.name}${on ? " allowed." : " denied."}` : r.msg, r.ok ? "ok" : "error"))} />
            </div>
          ))}
        </div>
      </div>
      <details className="int-more" id="mcp-d-more">
        <summary>Settings, scope, access check and recent calls</summary>
        <Detail srv={srv} cat={cat} projects={projects} agents={agents} repos={repos} calls={calls} actorName={actorName} onRemoved={close} />
      </details>
    </CrDrawer>
  );
}
