/** Skills and MCP tab in the Blueprint layout: two flush list panels, each row an icon, the name, a description and Open. */
import { useMcpServers, useSkills } from "../../api/queries";
import { Btn, Panel } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { navigate } from "../../lib/router";
import type { TabProps } from "./Config";

export function SkillsTab({ a }: TabProps) {
  const skills = useSkills().data ?? [];
  const mcp = useMcpServers().data ?? [];
  return (
    <div className="cols">
      <Panel title="Skills" flush>
        {a.skills.length ? (
          <ul className="list">
            {a.skills.map((id) => {
              const sk = skills.find((x) => x.id === id);
              return (
                <li key={id}>
                  <Icon name="skill" />
                  <div className="grow"><b>{sk?.name ?? id}</b><div className="small muted">{sk?.desc}</div></div>
                  <Btn label="Open" small id={`ag-sk-open-${id}`} onClick={() => navigate("skills", id)} />
                </li>
              );
            })}
          </ul>
        ) : <div className="empty">No skills.</div>}
      </Panel>
      <Panel title="MCP servers" flush>
        {a.mcp.length ? (
          <ul className="list">
            {a.mcp.map((id) => (
              <li key={id}>
                <Icon name="server" />
                <div className="grow">{mcp.find((x) => x.id === id)?.name ?? id}</div>
                <Btn label="Open" small id={`ag-mcp-open-${id}`} onClick={() => navigate("mcp", id)} />
              </li>
            ))}
          </ul>
        ) : <div className="empty">No MCP servers.</div>}
      </Panel>
    </div>
  );
}
