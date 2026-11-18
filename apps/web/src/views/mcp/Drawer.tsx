/** The MCP server drawer, in the prototype's anatomy: URL, Auth, Health, a Tools card (name, Write or Read only, allow switch), Refresh definitions and Done. */
import { useMcpServers } from "../../api/queries";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { CrDrawer, Kv } from "../connect/kit";
import { Health, authLabel, dec } from "./kit";

export function ServerDrawer({ id, close }: { id: string; close: () => void }) {
  const ui = useUI();
  const srv = (useMcpServers().data ?? []).find((m) => m.id === id);
  const perm = dec(useCan("mcp.edit"));
  if (!srv) return null;
  const v = srv.version !== undefined ? { ifMatch: srv.version } : undefined;
  return (
    <CrDrawer
      eyebrow="MCP server" title={srv.name} close={close}
      foot={(
        <>
          <Btn label="Refresh definitions" id="mcp-d-refresh" guard={perm} onClick={() => { ui.toast(`Refreshing ${srv.name}…`, "info"); void ops.rediscoverMCP(srv.id, v).then((r) => ui.toast(r.msg, r.ok ? "ok" : "error")); }} />
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
              <Toggle id={`mcp-dtool-${i}`} checked={t.allowed} label={`${t.name} allowed`} decision={perm} onChange={(on) => void ops.updateMCP(srv.id, { tools: [{ name: t.name, allowed: on }] }, v).then((r) => ui.toast(r.ok ? `${on ? "Enabled" : "Disabled"} ${t.name} allowed` : r.msg, r.ok ? "ok" : "error"))} />
            </div>
          ))}
        </div>
      </div>
    </CrDrawer>
  );
}
