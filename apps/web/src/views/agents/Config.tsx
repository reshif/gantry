/** Configuration and Per-project tabs in the Blueprint layout: Identity (kv list) and Tools side by side, Guardrail paths below. The model, autonomy and tool controls write at once and toast, as the prototype does. */
import { fmt, type Policy, type Project } from "@gantry/domain";
import { Chip, Select, Toggle, Panel, type Decision } from "../../ui/primitives";
import { DataTable, type SortCol } from "../../ui/SortTable";
import { Icon } from "../../ui/Icon";
import { useEvalsFactory } from "../../api/queries";
import { AUTONOMY, TOOLS, autonomyCheck, useModels, useStations, type AgentRow } from "./kit";

export interface TabProps {
  a: AgentRow;
  ro: boolean;
  perm: Decision;
  projects: Project[];
  policies: Policy[];
  /** Writes one change to the agent at once (If-Match the revision shown) and toasts `msg`. */
  apply: (patch: Record<string, unknown>, msg: string) => void;
  /** Instructions tab: save the text, then cut a version from it. */
  saveAsVersion: (text: string) => void;
}

export function ConfigTab({ a, ro, perm, projects, policies, apply }: TabProps) {
  const m = useModels();
  const st = useStations();
  const station = st.find(a.station);
  const check = (autonomy: string) => autonomyCheck(policies, projects, { station: a.station, projects: a.projects }, autonomy);
  const modelOpts = m.all.map((x) => ({ value: x.id, label: x.name })).concat(m.all.some((x) => x.id === a.model) ? [] : [{ value: a.model, label: `${m.name(a.model)} (not available)` }]);
  const autoValues = [...new Set([...AUTONOMY.map((o) => o[0]), a.autonomy])];
  const paths = a.guardrails.paths;
  const tools: Record<string, boolean> = { ...a.tools };
  return (
    <>
      <div className="cols">
        <Panel title="Identity">
          <dl className="kv">
            <dt>Station</dt><dd>{station?.name ?? "Roaming"}</dd>
            <dt>Model</dt>
            <dd><Select id="ag-model" aria-label="Model" disabled={ro} options={modelOpts} value={a.model} onChange={(v) => { if (v !== a.model) apply({ model: v, fallbacks: a.fallbacks.filter((x) => x !== v) }, `Model set to ${v}`); }} /></dd>
            <dt>Fallbacks</dt><dd>{a.fallbacks.length ? a.fallbacks.join(", ") : "None"}</dd>
            <dt>Autonomy</dt>
            <dd>
              <Select id="ag-autonomy" aria-label="Autonomy" disabled={ro} value={a.autonomy}
                options={autoValues.map((v) => { const c = check(v); return { value: v, label: c.allowed ? v : `${v} (blocked by ${c.rule})`, disabled: !c.allowed && v !== a.autonomy }; })}
                onChange={(v) => { if (v !== a.autonomy) apply({ autonomy: v }, `Autonomy: ${v}`); }} />
              {!check(a.autonomy).allowed ? <div className="small neg"><Icon name="lock" /> {check(a.autonomy).reason}</div> : null}
            </dd>
            <dt>Budget / run</dt><dd>{`$${a.budget}`}</dd>
            <dt>Max diff</dt><dd>{a.guardrails.maxDiff ? `${a.guardrails.maxDiff} lines` : "No code changes"}</dd>
            <dt>Eval suite</dt><dd>{a.suite || "—"}</dd>
          </dl>
        </Panel>
        <Panel title="Tools">
          <div>
            {TOOLS.map((t) => (
              <label key={t[0]} className="check ag-tool-row" htmlFor={`ag-tool-${t[0]}`} style={{ justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted var(--line)" }}>
                <span>{t[0]}</span>
                <Toggle id={`ag-tool-${t[0]}`} checked={!!tools[t[0]]} decision={perm} label={t[0]} onChange={(v) => apply({ tools: { ...tools, [t[0]]: v } }, `${t[0]} ${v ? "enabled" : "disabled"}`)} />
              </label>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Guardrail paths">
        {paths.length ? <pre className="pre">{paths.join("\n")}</pre> : <div className="empty">No protected paths for this agent.</div>}
      </Panel>
    </>
  );
}

export function OverridesTab({ a, projects }: TabProps) {
  const heat = useEvalsFactory().data?.heat?.[a.id];
  const rows = projects;
  const cols: SortCol<Project>[] = [
    { key: "p", label: "Project", render: (p) => p.name },
    { key: "o", label: "Override", render: (p) => (a.overrides[p.id] ? <Chip text="custom" cls="info" /> : <span className="muted">Uses default</span>) },
    { key: "sc", label: "Eval", align: "end", render: (p) => { const v = heat?.[p.id]; return v == null ? "—" : <span className="num">{fmt.pct(v)}</span>; } },
  ];
  return (
    <Panel title="Overrides" flush>
      <DataTable id="ag-ov" caption="Per-project overrides" columns={cols} rows={rows} rowKey={(p) => p.id} pageSize={12} pager sortSelect={false} />
    </Panel>
  );
}
