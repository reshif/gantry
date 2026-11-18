/** The MCP servers the agent may call, shown under the Skills tab (the skill switches and their order are in proto.tsx). */
import { useMcpServers } from "../../api/queries";
import { Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import type { TabProps } from "./Config";

export function SkillsTab({ a, d, perm, edit }: TabProps) {
  const mcp = useMcpServers().data ?? [];
  return (
    <div className="cfg">
      <section className="cfg-sec">
        <h3 className="cfg-h">MCP servers allowed</h3>
        <p className="muted small">The agent may call a server only when it is allowed here and the server is scoped to it in MCP. Write tools still need a gate.</p>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr>{["Server", "Health", "Data", "Tools", "MCP scope", "Allowed"].map((x, i) => <th key={x} scope="col" className={i === 3 ? "num" : ""}>{x}</th>)}</tr></thead>
            <tbody>
              {mcp.map((m) => {
                const on = d.mcp.includes(m.id);
                const scoped = m.agents === "all" || (m.agents ?? []).includes(a.id);
                const writes = m.tools.filter((t) => t.write && t.allowed).length;
                return (
                  <tr key={m.id}>
                    <td><div><strong>{m.name}</strong></div><div className="mono small muted">{m.id}</div></td>
                    <td><span className={`health h-${m.health === "healthy" ? "healthy" : m.health === "degraded" ? "degraded" : "offline"}`}><span className="health-shape" aria-hidden="true" />{m.health}</span></td>
                    <td className="small">{m.sensitivity}</td>
                    <td className="num mono small">{m.tools.length + (writes ? ` (${writes} write${m.writeGate ? ", gated" : ""})` : "")}</td>
                    <td className="small">{on && !scoped ? <span className="warn-text"><Icon name="alert" /> Not scoped to this agent in MCP</span> : scoped ? "Scoped in MCP" : <span className="muted">Not scoped</span>}</td>
                    <td><Toggle id={`ag-mcp-${m.id}`} checked={on} decision={perm} label={`Allow ${m.name}`} onChange={(v) => edit(() => { d.mcp = v ? [...d.mcp, m.id] : d.mcp.filter((x) => x !== m.id); })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
