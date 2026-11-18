/** Skills and MCP tab: two flush list panels (icon, name, description, Open); attach, reorder and detach stay available and are saved with the agent. */
import { useMcpServers, useSkills } from "../../api/queries";
import { Btn, Panel, Select } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { navigate } from "../../lib/router";
import type { TabProps } from "./Config";

export function SkillsTab({ d, ro, perm, edit }: TabProps) {
  const skills = useSkills().data ?? [];
  const mcp = useMcpServers().data ?? [];
  const move = (i: number, to: number) => edit(() => { const [x] = d.skills.splice(i, 1); d.skills.splice(to, 0, x as string); });
  const addable = skills.filter((sk) => !d.skills.includes(sk.id));
  const addableMcp = mcp.filter((m) => !d.mcp.includes(m.id));
  const lock = (extra: string | null) => (ro ? perm.reason : extra);
  return (
    <div className="cols">
      <Panel title="Skills" flush>
        {d.skills.length ? (
          <ul className="list ag-skill-chain">
            {d.skills.map((id, i) => {
              const sk = skills.find((x) => x.id === id);
              return (
                <li key={id}>
                  <Icon name="skill" />
                  <div className="grow"><b>{sk?.name ?? id}</b><div className="small muted">{sk?.desc}</div></div>
                  <Btn icon="up" small id={`ag-sk-up-${id}`} aria={`Move ${sk?.name ?? id} up`} disabledReason={lock(i === 0 ? "Already first." : null)} onClick={() => move(i, i - 1)} />
                  <Btn icon="down" small id={`ag-sk-down-${id}`} aria={`Move ${sk?.name ?? id} down`} disabledReason={lock(i === d.skills.length - 1 ? "Already last." : null)} onClick={() => move(i, i + 1)} />
                  <Btn icon="x" small id={`ag-sk-rm-${id}`} aria={`Detach ${sk?.name ?? id}`} disabledReason={lock(null)} onClick={() => edit(() => { d.skills.splice(i, 1); })} />
                  <Btn label="Open" small id={`ag-sk-open-${id}`} onClick={() => navigate("skills", id)} />
                </li>
              );
            })}
          </ul>
        ) : <div className="empty">No skills.</div>}
        <div className="ag-attach"><Select id="ag-sk-add" aria-label="Attach a skill" disabled={ro || !addable.length} value="" options={[{ value: "", label: "Attach a skill…" }, ...addable.map((sk) => ({ value: sk.id, label: sk.name }))]} onChange={(v) => { if (v) edit(() => { d.skills.push(v); }); }} /></div>
      </Panel>
      <Panel title="MCP servers" flush>
        {d.mcp.length ? (
          <ul className="list">
            {d.mcp.map((id) => {
              const m = mcp.find((x) => x.id === id);
              return (
                <li key={id}>
                  <Icon name="server" />
                  <div className="grow">{m?.name ?? id}</div>
                  <Btn icon="x" small id={`ag-mcp-rm-${id}`} aria={`Do not allow ${m?.name ?? id}`} disabledReason={lock(null)} onClick={() => edit(() => { d.mcp = d.mcp.filter((x) => x !== id); })} />
                  <Btn label="Open" small id={`ag-mcp-open-${id}`} onClick={() => navigate("mcp", id)} />
                </li>
              );
            })}
          </ul>
        ) : <div className="empty">No MCP servers.</div>}
        <div className="ag-attach"><Select id="ag-mcp-add" aria-label="Allow an MCP server" disabled={ro || !addableMcp.length} value="" options={[{ value: "", label: "Allow an MCP server…" }, ...addableMcp.map((m) => ({ value: m.id, label: m.name }))]} onChange={(v) => { if (v) edit(() => { d.mcp = [...d.mcp, v]; }); }} /></div>
      </Panel>
    </div>
  );
}
