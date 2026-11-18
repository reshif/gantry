/**
 * The agent page tabs in the Control Room layout (prototype js/s-work.js agentDetail): Overview, Instructions, Tools, Model and budget, Skills,
 * Guardrails, Evals. They edit the same draft the page's save bar saves (G-02: one audited change), so a toggle here is a draft edit, never a silent write.
 * Figures the backend does not carry are shown as "not available" instead of invented.
 */
import { useMemo, useState } from "react";
import { fmt } from "@gantry/domain";
import { useAllSuiteRuns, useInstructions, useScorecards, useSkills, useWorkOrders } from "../../api/queries";
import { usePrefs } from "../../lib/prefs";
import { hashFor, navigate } from "../../lib/router";
import { Btn, Chip, Field, IconBtn, Select, Toggle, type Decision } from "../../ui/primitives";
import { Bars, Card, CrIcon, Stats } from "../../ui/cr";
import { DataTable, type SortCol } from "../../ui/DataTable";
import { useUI } from "../../ui/overlay-context";
import { lineDiff } from "../../ui/linediff";
import { TOOLS, liveVersion, useModels, useStations, type AgentRow } from "./kit";
import type { TabProps } from "./Config";

/** The server has three autonomy modes; they map onto the prototype's ladder: suggest = L0 (every output goes to a person), gate = L2 (acts, a person decides at the gate), auto = L4 (moves work on unattended). */
export const levelOf = (a: Pick<AgentRow, "autonomy">): number => (a.autonomy === "auto" ? 4 : a.autonomy === "gate" ? 2 : 0);
const NA = "not available";
/** Finished attempts over the last four weekly buckets (28 days, the longest whole-week window the scorecard keeps); null when the server sent none. */
export const runs30 = (c: { trend?: { n?: number[] } } | undefined): number | null => (c?.trend?.n?.length ? c.trend.n.slice(-4).reduce((t, x) => t + x, 0) : null);
const SENSITIVE = /^(merge|readSecrets|sendEmail|openPR)$/;

export function useAgentFacts(a: AgentRow) {
  const sc = useScorecards().data?.[a.id];
  const runs = (useAllSuiteRuns().data ?? []).filter((r) => r.agent === a.id).sort((x, y) => y.at - x.at);
  return { sc, evalRuns: runs };
}

type Run = { wo: string; at: number; outcome: string | null; ms: number | null; cost: number };

/** Recent runs: the history entries of this agent on the work orders of the project in view (real attempts, with their real outcome, time and cost). */
function useRecentRuns(a: AgentRow): Run[] {
  const project = usePrefs().project;
  const q = useWorkOrders(project);
  return useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : q.data?.items ?? [];
    const out: Run[] = [];
    for (const w of list) for (const h of w.history ?? []) if (h.agent === a.id) out.push({ wo: w.id, at: h.startedAt, outcome: h.outcome, ms: h.endedAt ? h.endedAt - h.startedAt : null, cost: h.cost });
    return out.sort((x, y) => y.at - x.at).slice(0, 6);
  }, [q.data, a.id]);
}

const outcomeChip = (o: string | null) => (o == null ? <Chip text="Running" cls="info" /> : /fail|rework|reject|block/i.test(o) ? <Chip text={o[0]!.toUpperCase() + o.slice(1)} cls="warn" /> : <Chip text={o[0]!.toUpperCase() + o.slice(1)} cls="ok" />);

export function KvList({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return <dl className="kv">{rows.flatMap(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{v}</dd>])}</dl>;
}

export function OverviewTab({ a, d, onTab }: TabProps & { onTab: (t: string) => void }) {
  const st = useStations();
  const { sc, evalRuns } = useAgentFacts(a);
  const recent = useRecentRuns(a);
  const skillList = useSkills().data ?? [];
  const trend = evalRuns.slice(0, 8).reverse().map((r) => Math.round(r.score * 100));
  const spark = (sc?.trend.success?.length ?? 0) > 1 ? sc!.trend.success : a.spark;
  const station = st.find(a.station);
  const cols: SortCol<Run>[] = [
    { key: "wo", label: "Work order", render: (r) => <a className="rl mono" href={hashFor("record", r.wo)}>{r.wo}</a> },
    { key: "outcome", label: "Outcome", render: (r) => outcomeChip(r.outcome) },
    { key: "ms", label: "Duration", mobileLabel: "Time", align: "end", render: (r) => <span className="mono">{r.ms == null ? "\u2014" : `${Math.max(1, Math.round(r.ms / 60000))}m`}</span> },
    { key: "cost", label: "Cost", align: "end", render: (r) => <span className="mono">{fmt.money(r.cost)}</span> },
  ];
  return (
    <div className="grid g-main2">
      <div className="stack">
        <Stats items={[
          { l: "Eval score", v: Number.isFinite(a.evalScore) ? a.evalScore.toFixed(2) : "—", tone: "ok", ...(spark && spark.length > 1 ? { spark } : {}) },
          { l: "Rework", v: sc ? `${Math.round(sc.rework * 100)}%` : "—" },
          { l: "Runs, 30d", v: runs30(sc) ?? "—", tone: "info" },
          { l: "Autonomy", v: `L${levelOf(a)}`, tone: "agent" },
        ]} />
        <Card title="Recent runs" flush>
          <DataTable id="ag-runs" caption="Recent runs" columns={cols} rows={recent} rowKey={(r) => `${r.wo}-${r.at}`} empty={{ title: "No runs yet", text: "This agent has not worked on a work order in the project in view." }} />
        </Card>
      </div>
      <div className="stack">
        <Card title="Identity">
          <KvList rows={[
            ["Station", station ? station.name : "—"],
            ["Model", <span key="m" className="m">{a.model}</span>],
            ["Version", <span key="v" className="m">{a.version}</span>],
            ["Owner", <span key="o" className="dim">{NA}</span>],
            ["Budget", `$${d.budget} per run`],
            ["Skills", d.skills.length ? <span key="s" className="row">{d.skills.map((s) => <span key={s} className="tag">{skillList.find((x) => x.id === s)?.name ?? s.replace("sk-", "")}</span>)}</span> : "—"],
          ]} />
        </Card>
        <Card title="Eval trend" hint="Score of the last runs, percent">
          {trend.length ? <div className="ag-trend"><Bars data={trend} h={72} label={`${a.name} eval score`} /></div> : <p className="dim">No eval runs yet.</p>}
        </Card>
        <Card title="Guardrails" acts={<Btn label="Open" small id="ag-open-guardrails" onClick={() => onTab("guardrails")} />}>
          <KvList rows={[["Max diff", `${d.guardrails.maxDiff} lines`], ["Forbidden paths", `${d.guardrails.paths.length} patterns`], ["On violation", "Stop and ask a person"]]} />
        </Card>
      </div>
    </div>
  );
}

/** Instructions: the working copy in one card, a diff against the saved text, and a new version that runs the eval suite first. The layered view stays beneath. */
export function InstructionsCard({ a, d, ro, edit, onSaveVersion, saving }: Pick<TabProps, "a" | "d" | "ro" | "edit"> & { onSaveVersion: () => void; saving: boolean }) {
  const ui = useUI();
  const live = liveVersion(a);
  const showDiff = () => {
    const lines = lineDiff(a.instructions ?? "", d.instructions ?? "").filter((l) => l.op !== "same");
    ui.drawer.open(`ag-diff:${a.id}`, (close) => (
      <div className="drawer-inner">
        <div className="drawer-h">
          <div><div className="eyebrow">Diff</div><h2>{`${a.name} instructions`}</h2></div>
          <IconBtn icon="x" label="Close" className="drawer-close" onClick={close} />
        </div>
        <div className="drawer-b">
          {lines.length ? (
            <pre className="code diff" style={{ padding: 8 }}>{lines.map((l, i) => <div key={i} className={l.op}>{`${l.op === "add" ? "+" : "-"} ${l.text}`}</div>)}</pre>
          ) : <div className="empty"><h3>No changes</h3><p>Your text matches the saved version.</p></div>}
        </div>
      </div>
    ));
  };
  // The prototype opens an agent's text as "# <Name>" over the factory base; shown, not saved, until the person edits it.
  const base = useInstructions().data?.base;
  const [touched, setTouched] = useState(false);
  const own = d.instructions ?? "";
  const text = touched || own ? own : base ? `# ${a.name}\n\n${base}` : "";
  const cand = a.versions.filter((v) => !v.live && /-rc\d+$/.test(String(v.v))).at(-1);
  return (
    <Card title="Instructions" hint="Saving creates a new version and runs the eval suite before it goes live">
      <div className="stack">
        <textarea id="ag-instr-main" className="in input mono" rows={16} style={{ fontSize: 12, lineHeight: "18px" }} aria-label="Instructions" disabled={ro} value={text} onChange={(e) => { setTouched(true); edit(() => { d.instructions = e.target.value; }); }} />
        <div className="row spread">
          <span className="dim mono" id="ag-instr-count">{`${text.length} characters · live version ${live?.v ?? a.version}${cand ? ` · ${cand.v} saved, awaiting its eval suite` : ""}`}</span>
          <span className="row">
            <Btn label="Show diff" id="ag-instr-diff" onClick={showDiff} />
            <Btn label="Save as new version" kind="primary" id="ag-instr-save" disabledReason={ro ? "You cannot edit this agent." : saving ? "Saving…" : null} onClick={onSaveVersion} />
          </span>
        </div>
      </div>
    </Card>
  );
}

export function confirmNewVersion(ui: ReturnType<typeof useUI>, a: AgentRow, run: () => void): void {
  ui.dialog({
    title: `Save a new version of ${a.name}?`,
    sub: "The eval suite runs first. If the score drops below the threshold it will not go live.",
    body: null,
    actions: [{ label: "Cancel" }, { label: "Save and run evals", kind: "primary", submit: true, id: "ag-instr-confirm", onClick: (done) => { run(); done(); } }],
  });
}

export function ToolsTab({ d, perm, ro, edit }: TabProps) {
  const ui = useUI();
  return (
    <Card title="Tools" flush>
      <div className="list">
        {TOOLS.map(([id]) => {
          const danger = SENSITIVE.test(id);
          const on = !!d.tools[id];
          return (
            <div key={id} className="setrow">
              <div className="tx"><b className="mono">{id}</b><span>{danger ? "Sensitive: needs a Factory Admin" : "Allowed for this station"}</span></div>
              <Toggle id={`ag-tool-${id}`} checked={on} label={id} decision={ro ? perm : danger ? { allowed: false, needs: "Factory Admin", reason: "Sensitive: needs a Factory Admin" } : null} onChange={(v) => { edit(() => { d.tools[id] = v; }); ui.toast(`${v ? "Enabled" : "Disabled"} ${id}`, "ok"); }} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Like the prototype, a changed Model or Budget is saved at once ("Saved model"); `onSave` writes just that key. */
export function ModelTab({ a, d, ro, edit, onSave }: TabProps & { onSave: (key: "model" | "budget", value: string | number) => void }) {
  const m = useModels();
  const opts = m.list.map((x) => ({ value: x.id, label: x.id })).concat(m.list.some((x) => x.id === d.model) ? [] : [{ value: d.model, label: `${d.model} (not available)` }]);
  const commitBudget = (): void => { if (d.budget !== a.budget) onSave("budget", d.budget); };
  return (
    <Card title="Model and budget">
      <div className="grid g2">
        <Field label="Model" htmlFor="ag-model">
          <Select id="ag-model" options={opts} value={d.model} disabled={ro} onChange={(v) => { edit(() => { d.model = v; d.fallbacks = d.fallbacks.filter((x) => x !== v); }); if (v !== a.model) onSave("model", v); }} />
        </Field>
        <Field label="Budget per run (USD)" htmlFor="ag-budget" hint="The run stops when it reaches this.">
          <input id="ag-budget" className="input mono" type="number" min="0" step="0.1" value={String(d.budget)} disabled={ro} onChange={(e) => edit(() => { d.budget = +e.target.value || 0; })} onBlur={commitBudget} onKeyDown={(e) => { if (e.key === "Enter") commitBudget(); }} />
        </Field>
      </div>
    </Card>
  );
}

/** The fallback order is kept (a working feature), on the Guardrails tab, since the prototype's Model tab holds only Model and Budget. */
export function FallbackCard({ a, d, ro, perm, edit }: TabProps) {
  return <Card title="Fallback models"><FallbackChain a={a} d={d} ro={ro} perm={perm} edit={edit} /></Card>;
}

/** The fallback order stays (the model chain is a working feature): primary first, then each fallback with move and remove. */
function FallbackChain({ d, ro, perm, edit }: Pick<TabProps, "a" | "d" | "ro" | "perm" | "edit">) {
  const m = useModels();
  const addable = m.list.filter((x) => x.id !== d.model && !d.fallbacks.includes(x.id));
  const move = (i: number, to: number) => edit(() => { const [x] = d.fallbacks.splice(i, 1); d.fallbacks.splice(to, 0, x as string); });
  return (
    <div className="field">
      <div className="field-label label">Fallbacks, tried in order</div>
      {d.fallbacks.length ? (
        <ol className="chain">
          {d.fallbacks.map((f, i) => (
            <li key={f}>
              <span className="mono chain-n">{i + 1}</span>
              <span className="mono">{f}</span>
              {m.usable(f) ? null : <span className="chip warn">vendor or model off, skipped</span>}
              <span className="chain-tools">
                <Btn icon="up" small id={`ag-fb-up-${i}`} aria={`Move ${f} up`} disabledReason={ro ? perm.reason : i === 0 ? "Already first." : null} onClick={() => move(i, i - 1)} />
                <Btn icon="down" small id={`ag-fb-down-${i}`} aria={`Move ${f} down`} disabledReason={ro ? perm.reason : i === d.fallbacks.length - 1 ? "Already last." : null} onClick={() => move(i, i + 1)} />
                <Btn icon="x" small id={`ag-fb-rm-${i}`} aria={`Remove ${f}`} disabledReason={ro ? perm.reason : null} onClick={() => edit(() => { d.fallbacks.splice(i, 1); })} />
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="dim">No fallbacks. If the primary fails, the work order blocks.</p>}
      <Select id="ag-fb-add" aria-label="Add fallback model" disabled={ro || !addable.length} value="" options={[{ value: "", label: "Add fallback model…" }, ...addable.map((x) => ({ value: x.id, label: x.id }))]} onChange={(v) => { if (v) edit(() => { d.fallbacks.push(v); }); }} />
    </div>
  );
}

export function SkillsListTab({ d, perm, ro, edit }: TabProps) {
  const ui = useUI();
  const skills = useSkills().data ?? [];
  const move = (i: number, to: number) => edit(() => { const [x] = d.skills.splice(i, 1); d.skills.splice(to, 0, x as string); });
  const lock: Decision | null = ro ? perm : null;
  return (
    <>
      <Card title="Skills" flush>
        <div className="list">
          {skills.map((s) => {
            const on = d.skills.includes(s.id);
            return (
              <div key={s.id} className="setrow">
                <div className="tx"><b>{s.name}</b><span>{s.desc}</span></div>
                <Toggle id={`ag-sk-${s.id}`} checked={on} label={`${s.name} enabled`} decision={lock} onChange={(v) => { edit(() => { d.skills = v ? [...d.skills, s.id] : d.skills.filter((x) => x !== s.id); }); ui.toast(`${v ? "Enabled" : "Disabled"} ${s.name}`, "ok"); }} />
              </div>
            );
          })}
        </div>
      </Card>
      {d.skills.length ? (
        <Card title="Order and versions" hint="Earlier skills win when two give conflicting advice." cls="ag-sk-order">
          <ol className="chain ag-skill-chain">
            {d.skills.map((id, i) => {
              const sk = skills.find((x) => x.id === id);
              return (
                <li key={id}>
                  <span className="mono chain-n">{i + 1}</span>
                  <span className="ag-sk-main"><strong>{sk ? sk.name : id}</strong><span className="mono dim">{sk ? ` v${sk.version}` : " missing"}</span></span>
                  <span className="chain-tools">
                    <Btn icon="up" small id={`ag-sk-up-${id}`} aria={`Move ${sk ? sk.name : id} up`} disabledReason={ro ? perm.reason : i === 0 ? "Already first." : null} onClick={() => move(i, i - 1)} />
                    <Btn icon="down" small id={`ag-sk-down-${id}`} aria={`Move ${sk ? sk.name : id} down`} disabledReason={ro ? perm.reason : i === d.skills.length - 1 ? "Already last." : null} onClick={() => move(i, i + 1)} />
                  </span>
                </li>
              );
            })}
          </ol>
          <a href="#skills" className="rl" id="ag-goto-skills" onClick={(e) => { e.preventDefault(); navigate("skills"); }}>Open the skills library</a>
        </Card>
      ) : null}
    </>
  );
}

export function GuardrailsTab({ d, ro, edit }: TabProps) {
  const [paths, setPaths] = useState(d.guardrails.paths.join("\n"));
  return (
    <Card title="Guardrails">
      <div className="stack">
        <KvList rows={[
          ["Max diff", <span key="md" className="mono">{d.guardrails.maxDiff ? `${d.guardrails.maxDiff} lines` : "no limit"}</span>],
          ["Forbidden paths", d.guardrails.paths.length ? <span key="fp" className="row">{d.guardrails.paths.map((p) => <code key={p}>{p}</code>)}</span> : "none"],
          ["On violation", "Stop and ask a person"],
        ]} />
        <div className="banner"><CrIcon name="info" /><div className="grow">Guardrails are enforced by the platform, not by the agent. Changing them is recorded in the audit ledger.</div></div>
        <Field label="Max diff size (lines)" htmlFor="ag-maxdiff" hint="0 means no limit.">
          <input id="ag-maxdiff" className="input mono" type="number" min="0" step="50" value={String(d.guardrails.maxDiff)} disabled={ro} onChange={(e) => edit(() => { d.guardrails.maxDiff = +e.target.value || 0; })} />
        </Field>
        <Field label="Forbidden paths" htmlFor="ag-paths" hint="One glob per line.">
          <textarea id="ag-paths" className="input mono" rows={3} disabled={ro} placeholder="infra/prod/**" value={paths} onChange={(e) => { setPaths(e.target.value); edit(() => { d.guardrails.paths = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); }); }} />
        </Field>
      </div>
    </Card>
  );
}

export function EvalsTab({ a }: { a: AgentRow }) {
  const { evalRuns } = useAgentFacts(a);
  const rows = evalRuns.slice(0, 8);
  const cols: SortCol<(typeof rows)[number]>[] = [
    { key: "id", label: "Run", render: (r) => <span className="mono">{r.id}</span> },
    { key: "at", label: "When", render: (r) => <span className="mono dim">{fmt.ago(r.at, Date.now())}</span> },
    { key: "version", label: "Version", render: (r) => <span className="mono">{r.version}</span> },
    { key: "score", label: "Score", align: "end", render: (r) => <span className="mono">{r.score.toFixed(2)}</span> },
  ];
  return (
    <Card title="Eval history" flush>
      <DataTable id="ag-evals-t" caption="Eval history" columns={cols} rows={rows} rowKey={(r) => r.id} empty={{ title: "No eval runs yet", text: "Run the suite from the Versions tab." }} />
    </Card>
  );
}
