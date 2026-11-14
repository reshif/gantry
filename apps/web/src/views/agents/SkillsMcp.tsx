/** Skills and MCP tab (legacy skillsTab): the ordered skill chain with attach, reorder and detach (saved with the agent), and the MCP servers the agent may call. */
import { useMcpServers, useSkills } from "../../api/queries";
import { Btn, Select, Toggle } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { navigate } from "../../lib/router";
import type { TabProps } from "./Config";

export function SkillsTab({ a, d, ro, perm, edit }: TabProps) {
  const skills = useSkills().data ?? [];
  const mcp = useMcpServers().data ?? [];
  const move = (i: number, to: number) => edit(() => { const [x] = d.skills.splice(i, 1); d.skills.splice(to, 0, x as string); });
  const addable = skills.filter((sk) => !d.skills.includes(sk.id));
  return (
    <div className="cfg">
      <section className="cfg-sec">
        <h3 className="cfg-h">Skills, in order</h3>
        <p className="muted small">Earlier skills win when two give conflicting advice. Edit skill text in Skills.</p>
        {d.skills.length ? (
          <ol className="chain ag-skill-chain">
            {d.skills.map((id, i) => {
              const sk = skills.find((x) => x.id === id);
              const enabledHere = sk && (sk.projects === "all" || sk.projects.length);
              return (
                <li key={id}>
                  <span className="mono chain-n">{i + 1}</span>
                  <span className="ag-sk-main">
                    <strong>{sk ? sk.name : id}</strong><span className="mono small muted">{sk ? ` v${sk.version}` : " missing"}</span>
                    {sk ? <span className="small muted ag-sk-when">{sk.when}</span> : null}
                  </span>
                  {sk && !enabledHere ? <span className="chip chip-warn">not enabled in any project</span> : null}
                  <span className="chain-tools">
                    <Btn icon="up" small id={`ag-sk-up-${id}`} aria={`Move ${sk ? sk.name : id} up`} disabledReason={ro ? perm.reason : i === 0 ? "Already first." : null} onClick={() => move(i, i - 1)} />
                    <Btn icon="down" small id={`ag-sk-down-${id}`} aria={`Move ${sk ? sk.name : id} down`} disabledReason={ro ? perm.reason : i === d.skills.length - 1 ? "Already last." : null} onClick={() => move(i, i + 1)} />
                    <Btn icon="x" small id={`ag-sk-rm-${id}`} aria={`Detach ${sk ? sk.name : id}`} disabledReason={ro ? perm.reason : null} onClick={() => edit(() => { d.skills.splice(i, 1); })} />
                  </span>
                </li>
              );
            })}
          </ol>
        ) : <p className="muted small">No skills attached.</p>}
        <Select id="ag-sk-add" aria-label="Attach a skill" disabled={ro || !addable.length} value="" options={[{ value: "", label: "Attach a skill…" }, ...addable.map((sk) => ({ value: sk.id, label: `${sk.name} v${sk.version}` }))]} onChange={(v) => { if (v) edit(() => { d.skills.push(v); }); }} />
        <a href="#skills" className="linkish small" id="ag-goto-skills" onClick={(e) => { e.preventDefault(); navigate("skills"); }}>Open the skills library</a>
      </section>
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
