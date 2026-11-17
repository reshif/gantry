/** Where agents talk: which configured agent backs each conversational surface (Intake interview, work-order session, onboarding session, console), and the console's binding. */
import { useCan } from "../../api/can";
import { useAgentBindings, useAgents } from "../../api/queries";
import { ops } from "../../api/ops";
import { Select, LockNote, type Decision } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export function BindingsPanel() {
  const ui_ = useUI();
  const rows = useAgentBindings().data?.surfaces ?? [];
  const agents = (useAgents().data ?? []).filter((x) => x.status === "active");
  const guard = dec(useCan("agent.edit"));
  if (!rows.length) return null;
  return (
    <section className="cfg-sec" id="ag-bindings">
      <h3 className="cfg-h">Where agents talk</h3>
      <p className="muted small">Each conversation uses its agent&apos;s live instructions and skills, composed like a station run with the factory base and the project overlay. Gantry only adds the tools and the safety rules.</p>
      <LockNote decision={guard} what="The console's agent" />
      <ul className="ag-layers">
        {rows.map((r) => (
          <li key={r.surface} className="ag-layer">
            <div className="ag-layer-head"><strong>{r.label}</strong><span className="muted small">{r.agentName ?? (r.agent ? r.agent : "no agent bound")}</span></div>
            <p className="muted small">{r.note}</p>
            {r.configurable ? (
              <Select
                id="ag-bind-console" value={r.agent ?? ""} disabled={!guard.allowed}
                options={[{ value: "", label: "No agent (Gantry's fixed rules only)" }, ...agents.map((x) => ({ value: x.id, label: x.name }))]}
                onChange={(v) => { void ops.setConsoleAgent(v || null).then((res) => ui_.toast(res.msg, res.ok ? "ok" : "error")); }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
