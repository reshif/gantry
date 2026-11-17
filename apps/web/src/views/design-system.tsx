/**
 * Design system reference sheet (prototype #/design-system): every component, shown in both themes side by side,
 * paper drawing on the left and blueprint on the right. It is a reference page: static sample data, no reads, no writes.
 */
import { useState } from "react";
import { DataTable } from "../ui/DataTable";
import { Spark } from "../ui/charts";
import { Btn, Chip, Empty, Field, FilterBar, Meter, Panel, Select, SearchBox, Stat, StatRow, Tabs, Toggle, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { updatePrefs, usePrefs, applyTheme } from "../lib/prefs";

const TOKENS = ["bg", "surface", "surface2", "sunk", "ink", "ink2", "ink3", "line", "line2", "accent", "accent-soft", "ok", "warn", "bad"];
const AGENTS = [
  { id: "a1", name: "Intake Clerk", model: "claude-haiku-5-5", autonomy: "auto", eval: 0.94 },
  { id: "a2", name: "Spec Writer", model: "claude-sonnet-5-5", autonomy: "gate", eval: 0.88 },
  { id: "a3", name: "Builder", model: "claude-sonnet-5-5", autonomy: "gate", eval: 0.91 },
  { id: "a4", name: "Reviewer", model: "claude-opus-5-5", autonomy: "auto", eval: 0.86 },
  { id: "a5", name: "Release Manager", model: "claude-haiku-5-5", autonomy: "gate", eval: 0.97 },
];
const TABS = ["Overview", "Configuration", "Instructions", "Skills and MCP", "Per-project", "Versions", "Evaluations", "History"];
const STATE_ROWS: Array<[string, string, string]> = [["empty", "Empty", "Nothing here yet."], ["error", "Failed to load", "Retry or reload."], ["lock", "No access", "Ask an admin."]];

function Gallery({ sc }: { sc: string }) {
  const ui = useUI();
  const [tab, setTab] = useState("Overview");
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState("");
  const [on, setOn] = useState(true);
  const rows = AGENTS.filter((a) => (!q || a.name.toLowerCase().includes(q.toLowerCase())) && (!auto || a.autonomy === auto));
  return (
    <div className="stack">
      <Panel title="Colour tokens">
        <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))" }}>
          {TOKENS.map((t) => (
            <div key={t}>
              <div style={{ height: 36, background: `var(--${t})`, border: "1px solid var(--line2)" }} />
              <div className="mono small">{`--${t}`}</div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Type scale">
        <div className="stack">
          <div style={{ font: "600 28px var(--font)" }}>28 Page title, Space Grotesk 600</div>
          <div style={{ font: "600 18px var(--font)" }}>18 Section heading</div>
          <div>14 Body text for descriptions and tables. The quick brown gantry lifts a work order.</div>
          <div className="small muted">12.5 Meta and hints</div>
          <div className="micro">11 Mono micro-label</div>
          <div className="num" style={{ fontSize: 28, fontWeight: 600 }}>1,284.50 tabular mono figures</div>
        </div>
      </Panel>
      <Panel title="Buttons and chips">
        <div className="stack">
          <div className="row">
            <Btn kind="primary" label="Primary" />
            <Btn label="Default" />
            <Btn kind="ghost" label="Ghost" />
            <Btn kind="danger" label="Danger" />
            <Btn icon="plus" label="With icon" />
            <Btn label="Disabled" disabledReason="Locked sample" />
          </div>
          <div className="row">
            <Chip text="Running" cls="info" />
            <Chip text="Passed" cls="ok" />
            <Chip text="At gate" cls="warn" />
            <Chip text="Failed" cls="bad" />
            <Chip text="Parked" cls="plain" />
            <Chip text="Neutral" />
          </div>
        </div>
      </Panel>
      <Panel title="Stat tiles">
        <StatRow>
          <Stat label="In flight" value="37" sub="on the line" />
          <Stat label="At gates" value="17" sub="to approve" tone="wait" />
          <Stat label="Stuck" value="3" sub="blocked" tone="block" />
        </StatRow>
      </Panel>
      <Panel title="Tab strip with overflow cue">
        <Tabs idPrefix={`ds-${sc}`} items={TABS.map((l, i) => ({ id: l, label: l, count: i % 3 ? null : i + 2 }))} active={tab} onChange={setTab} />
      </Panel>
      <Panel title="Filter bar and table" flush>
        <FilterBar count={`${rows.length} agents`} actions={q || auto ? <Btn small kind="ghost" label="Clear" onClick={() => { setQ(""); setAuto(""); }} /> : null}>
          <SearchBox value={q} onChange={setQ} placeholder="Search agents" />
          <Field label="Autonomy">
            <Select id={`ds-auto-${sc}`} value={auto} onChange={setAuto} options={[{ value: "", label: "All" }, "auto", "gate"]} />
          </Field>
        </FilterBar>
        <DataTable
          id={`ds-table-${sc}`}
          caption="Sample agents"
          rows={rows}
          rowKey={(a) => a.id}
          pageSize={3}
          columns={[
            { key: "name", label: "Agent", sort: true, render: (a) => <a className="pri" href="#agents">{a.name}</a> },
            { key: "model", label: "Model", render: (a) => <span className="mono small">{a.model}</span> },
            { key: "autonomy", label: "Autonomy", render: (a) => <Chip text={a.autonomy} cls={a.autonomy === "auto" ? "info" : "warn"} /> },
            { key: "eval", label: "Eval", align: "end", sort: true, render: (a) => `${Math.round(a.eval * 100)}%` },
          ]}
        />
      </Panel>
      <Panel title="Form fields">
        <Field label="Title" required hint="Helper text sits under the field.">
          <Select id={`ds-title-${sc}`} value="" options={[{ value: "", label: "Type a title" }]} />
        </Field>
        <Field label="Priority">
          <Select id={`ds-prio-${sc}`} value="P2" options={["P0", "P1", "P2"]} />
        </Field>
        <Field label="Notify me" htmlFor={`ds-notify-${sc}`}>
          <Toggle id={`ds-notify-${sc}`} checked={on} onChange={setOn} label="Notify me" />
        </Field>
        <Field label="Locked reason" error="Give a reason of at least 4 characters.">
          <Select id={`ds-bad-${sc}`} value="no" options={["no"]} />
        </Field>
      </Panel>
      <Panel title="Overlays">
        <div className="row">
          <Btn label="Open dialog" onClick={() => ui.dialog({ title: "Example dialog", body: <p>Dialogs hold a short task. Esc closes, focus is trapped.</p>, actions: [{ label: "Cancel" }, { label: "Save", kind: "primary" }] })} />
          <Btn label="Open drawer" onClick={() => ui.drawer.open(`ds-drawer-${sc}`, (close) => (
            <>
              <header><div style={{ minWidth: 0 }}><div className="micro">EXAMPLE</div><h2>Side drawer</h2></div><Btn kind="ghost" icon="x" aria="Close" cls="drawer-close" onClick={close} /></header>
              <div className="body"><p>Drawers hold detail without leaving the page. Esc closes.</p></div>
            </>
          ))} />
          <Btn label="Toast" onClick={() => ui.toast("Saved to the ledger", "ok")} />
          <Btn label="Menu" onClick={(e) => ui.menu(e.currentTarget, null, [{ label: "Edit", icon: "edit" }, { label: "Copy link", icon: "link" }, { sep: true }, { label: "Delete", icon: "trash" }])} />
        </div>
      </Panel>
      <Panel title="States">
        <div className="cols">
          {STATE_ROWS.map(([k, t, x]) => (
            <div key={k} style={{ border: "1px dashed var(--line2)" }}>
              <Empty icon={k === "empty" ? undefined : k === "error" ? "alert" : "lock"} title={t} text={x} action={<Btn small label="Action" />} />
            </div>
          ))}
        </div>
        <div style={{ height: 12 }} />
        <div className="callout warn"><b>Conflict</b>Priya changed this work order while you were editing. Reload to merge, or overwrite.</div>
      </Panel>
      <Panel title="Data display">
        <div className="cols">
          <div className="stack">
            <dl className="kv"><dt>Key</dt><dd>Value</dd><dt>Another</dt><dd><span className="mono">mono-value</span></dd></dl>
            <Meter value={0.62} max={1} label="Sample usage" />
            <Meter value={0.9} max={1} label="Sample usage, high" />
            <ol className="tl">
              <li className="ok"><time>Today 09:14</time><div>Approved G2</div></li>
              <li><time>Today 08:20</time><div>Entered Spec</div></li>
            </ol>
          </div>
          <div className="stack">
            <div className="row"><Spark values={[3, 5, 4, 7, 6, 9, 8]} w={100} h={28} label="Sample trend" />sparkline</div>
            <div className="heat" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
              {[0.62, 0.7, 0.8, 0.9, 0.97].map((v) => <div key={v} style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(v * 70)}%, var(--surface))` }}>{Math.round(v * 100)}</div>)}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

export default function DesignSystem() {
  const prefs = usePrefs();
  const next = prefs.theme === "dark" ? "light" : "dark";
  return (
    <div className="view">
      <ViewHead
        title="Design system"
        sub="Every component, shown in both themes side by side: paper drawing on the left, blueprint on the right."
        actions={<Btn icon={prefs.theme === "dark" ? "sun" : "moon"} label="Toggle app theme" onClick={() => { updatePrefs({ theme: next }); applyTheme(next); }} />}
      />
      <div className="cols" style={{ alignItems: "start" }}>
        <div data-scope="light">
          <h2 style={{ marginBottom: 12, fontSize: 18 }}>Paper drawing (light)</h2>
          <Gallery sc="light" />
        </div>
        <div data-scope="dark">
          <h2 style={{ marginBottom: 12, fontSize: 18 }}>Blueprint (dark)</h2>
          <Gallery sc="dark" />
        </div>
      </div>
    </div>
  );
}
