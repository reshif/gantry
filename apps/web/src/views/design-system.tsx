/**
 * Design system reference sheet (prototype #/design-system): every component, shown in both themes side by side,
 * paper drawing on the left and blueprint on the right. It is a reference page: static sample data, no reads, no writes.
 */
import { useState, type CSSProperties } from "react";
import { DataTable } from "../ui/DataTable";
import { BarList, Spark } from "../ui/charts";
import { Btn, Chip, Field, FilterBar, IconBtn, Meter, Panel, Select, SearchBox, Stat, StatRow, Tabs, TextInput, Toggle, ViewHead } from "../ui/primitives";
import { useUI, type UIApi } from "../ui/overlay-context";
import { updatePrefs, usePrefs, applyTheme } from "../lib/prefs";

const TOKENS = ["bg", "surface", "surface2", "sunk", "ink", "ink2", "ink3", "line", "line2", "accent", "accent-soft", "ok", "warn", "bad"];
/** Sample rows only (a reference page makes no reads): the first five agents of the prototype's seed. */
const AGENTS = [
  { id: "ag-intake", name: "Intake Clerk", model: "claude-haiku-5-5", autonomy: "auto", eval: 1 },
  { id: "ag-classifier", name: "Intake classifier", model: "claude-haiku-5-5", autonomy: "auto", eval: 0.875 },
  { id: "ag-research", name: "Researcher", model: "claude-opus-5-5", autonomy: "auto", eval: 0.9 },
  { id: "ag-spec", name: "Spec Writer", model: "claude-opus-5-5", autonomy: "gate", eval: 1 },
  { id: "ag-design", name: "Designer", model: "claude-opus-5-5", autonomy: "gate", eval: 0.9 },
];
/** The prototype strip is a static sample: choosing a tab changes nothing. */
/** The legacy aliases (--ink-2, --muted) resolve at :root; re-point them inside each scope so ghost buttons and muted text follow the scope's own palette. */
const SCOPE_ALIASES = { "--ink-2": "var(--ink2)", "--muted": "var(--ink3)" } as CSSProperties;
const noop = (): void => undefined;
const SPARK = [0.92, 0.89, 0.94, 0.87, 0.94, 0.9, 0.84];
const TABS = ["Overview", "Configuration", "Instructions", "Skills and MCP", "Per-project", "Versions", "Evaluations", "History"];
const TAB_COUNTS: Record<string, number> = { Overview: 2, "Skills and MCP": 5, Evaluations: 8 };

/** The prototype's stateBlock art paths, so the tiles draw the same glyphs. */
const ART: Record<string, string> = { empty: "M4 7h16v11H4zM4 7l3-3h10l3 3M9 12h6", error: "M12 3l10 18H2zM12 10v5M12 18h.01", lock: "M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" };
function StateTile({ kind, title, text }: { kind: "empty" | "error" | "lock"; title: string; text: string }) {
  return (
    <div style={{ border: "1px dashed var(--line2)" }}>
      <div className="state" role={kind === "error" ? "alert" : "status"}>
        <svg className="art" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true"><path d={ART[kind]} /></svg>
        <h3>{title}</h3>
        <p>{text}</p>
        <div className="row"><Btn small label="Action" /></div>
      </div>
    </div>
  );
}
function LoadingTile() {
  return (
    <div style={{ border: "1px dashed var(--line2)" }}>
      <div className="state" aria-busy="true" aria-label="Loading">
        {[90, 78, 66].map((w) => <div key={w} className="skel" style={{ width: `${w}%`, marginLeft: "auto", marginRight: "auto" }} />)}
      </div>
    </div>
  );
}

/** Floor vocabulary legend, drawn with the Floor's own symbol classes. */
function FloorLegend() {
  const t = (x: number, y: number, s: string) => <text x={x} y={y} className="f-txt2" textAnchor="middle">{s}</text>;
  const valve = (cls: string, x: number) => (
    <g key={x} className={`f-valve${cls}`}>
      <line x1={x} x2={x} y1={28} y2={18} stroke="var(--ink2)" strokeWidth={1.5} />
      <circle cx={x} cy={40} r={11} />
      <path d={`M${x - 4} 37 L${x + 4} 43 M${x + 4} 37 L${x - 4} 43`} stroke="var(--ink2)" />
    </g>
  );
  return (
    <div className="scrollwrap">
      <div className="sh">scroll →</div>
      <div className="tw">
        <svg viewBox="0 0 520 130" width={520} height={130} role="img" aria-label="Floor symbols">
          <rect x={10} y={10} width={100} height={60} className="f-block" />
          <rect x={10} y={10} width={100} height={22} className="f-head" />
          <text x={18} y={25} className="f-no">S5</text>
          <text x={40} y={25} className="f-name">Build</text>
          {t(60, 90, "Station block")}
          <path d="M150 20 H210 L200 62 H160 Z" className="f-hop" />
          <path d="M156 44 H204 L200 60 H160 Z" className="f-fill" />
          {t(180, 90, "Hopper (WIP)")}
          {valve("", 270)}{valve(" wait", 330)}{valve(" auto", 390)}
          {t(270, 90, "Gate (human)")}{t(330, 90, "Waiting")}{t(390, 90, "Gate (auto)")}
          <g className="f-tag"><rect x={430} y={28} width={80} height={22} rx={2} className="f-tb" /><text x={438} y={43}>WO-2417</text></g>
          <g className="f-tag wait"><rect x={430} y={58} width={80} height={22} rx={2} className="f-tb" /><text x={438} y={73}>WO-2404</text></g>
          {t(470, 104, "Work-order tags")}
        </svg>
      </div>
    </div>
  );
}

/** The example dialog: one required Name, "Name is required." on an empty save, a "Saved" toast otherwise. */
function ExampleForm({ box }: { box: { name: string; setErr: (e: string) => void } }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  box.setErr = setErr;
  return (
    <Field label={<>Name<span className="muted"> (required)</span></>} error={err || undefined}>
      <TextInput id="ds-dlg-name" aria-required="true" value={name} onChange={(v) => { setName(v); box.name = v; if (v.trim()) setErr(""); }} />
    </Field>
  );
}
function openExample(ui: UIApi) {
  const box = { name: "", setErr: (_: string) => undefined };
  ui.dialog({
    title: "Example dialog",
    body: <ExampleForm box={box} />,
    actions: [
      { label: "Cancel" },
      { label: "Save", kind: "primary", submit: true, onClick: (close) => { if (!box.name.trim()) { box.setErr("Name is required."); document.getElementById("ds-dlg-name")?.focus(); return; } ui.toast("Saved", "ok"); close(); } },
    ],
  });
}

function Gallery({ sc }: { sc: string }) {
  const ui = useUI();
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState("");
  const [on, setOn] = useState(false);
  const [title, setTitle] = useState("");
  const [titleErr, setTitleErr] = useState("");
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
            <IconBtn icon="bell" label="Icon button" />
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
        <Tabs idPrefix={`ds-${sc}`} items={TABS.map((l) => ({ id: l, label: l, count: TAB_COUNTS[l] ?? null }))} active="Overview" onChange={noop} />
      </Panel>
      <Panel title="Filter bar and table" flush>
        <FilterBar count={q || auto ? `${rows.length} agents of ${AGENTS.length}` : `${rows.length} agents`} actions={q || auto ? <Btn small kind="ghost" label="Clear" onClick={() => { setQ(""); setAuto(""); }} /> : null}>
          <SearchBox value={q} onChange={setQ} placeholder="Search…" label="Search agents" />
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the Select primitive is the control */}
          <label>
            <span>Autonomy</span>
            <Select id={`ds-auto-${sc}`} aria-label="Autonomy" value={auto} onChange={setAuto} options={[{ value: "", label: "All" }, "auto", "gate"]} />
          </label>
        </FilterBar>
        <DataTable
          sortHint
          sortSelect={false}
          rowHref={(a) => `#/agents/${a.id}`}
          rowLabel={(a) => a.name}
          id={`ds-table-${sc}`}
          caption="Sample agents"
          rows={rows}
          rowKey={(a) => a.id}
          pageSize={3}
          pager="pages"
          empty={{ title: "Nothing matches these filters", text: "Loosen the search or clear the filters.", action: <Btn small label="Clear filters" onClick={() => { setQ(""); setAuto(""); }} /> }}
          columns={[
            { key: "name", label: "Agent", sort: true, render: (a) => <a className="pri" href={`#/agents/${a.id}`}>{a.name}</a> },
            { key: "model", label: "Model", render: (a) => <span className="mono small">{a.model}</span> },
            { key: "autonomy", label: "Autonomy", render: (a) => <Chip text={a.autonomy} cls={a.autonomy === "auto" ? "info" : "warn"} /> },
            { key: "eval", label: "Eval", align: "end", sort: true, render: (a) => `${Math.round(a.eval * 100)}%` },
          ]}
        />
      </Panel>
      <Panel title="Form fields">
        <Field label={<>Title<span className="muted"> (required)</span></>} hint="Helper text sits under the field." error={titleErr || undefined}>
          <TextInput id={`ds-title-${sc}`} aria-required="true" value={title} onChange={(v) => { setTitle(v); if (v.trim()) setTitleErr(""); }} />
        </Field>
        <Field label="Priority">
          <Select id={`ds-prio-${sc}`} value="P0" options={["P0", "P1", "P2"]} />
        </Field>
        <div className="field">
          <label className="check" htmlFor={`ds-notify-${sc}`}>
            <Toggle id={`ds-notify-${sc}`} checked={on} onChange={setOn} />
            <span>Notify me</span>
          </label>
        </div>
        <Btn label="Validate" onClick={() => { if (!title.trim()) { setTitleErr("Title is required."); document.getElementById(`ds-title-${sc}`)?.focus(); } else setTitleErr(""); }} />
      </Panel>
      <Panel title="Overlays">
        <div className="row">
          <Btn label="Open dialog" onClick={() => openExample(ui)} />
          <Btn label="Open drawer" onClick={() => ui.drawer.open(`ds-drawer-${sc}`, (close) => (
            <>
              <header><div style={{ minWidth: 0 }}><div className="micro">EXAMPLE</div><h2>Side drawer</h2></div><Btn kind="ghost" icon="x" aria="Close" cls="drawer-close" onClick={close} /></header>
              <div className="body"><p>Drawers hold detail without leaving the page. Esc closes.</p></div>
            </>
          ))} />
          <Btn label="Toast" onClick={() => ui.toast("Saved to the ledger", "ok")} />
          <Btn label="Palette" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))} />
          <Btn label="Menu" onClick={(e) => ui.menu(e.currentTarget, null, [{ label: "Edit", icon: "edit" }, { label: "Copy link", icon: "link" }, { sep: true }, { label: "Delete", icon: "trash" }])} />
        </div>
      </Panel>
      <Panel title="States">
        <div className="cols">
          <StateTile kind="empty" title="Empty" text="Nothing here yet." />
          <LoadingTile />
          <StateTile kind="error" title="Failed to load" text="Retry or reload." />
          <StateTile kind="lock" title="No access" text="Ask an admin." />
        </div>
        <div style={{ height: 12 }} />
        <div className="callout warn"><b>Conflict</b>Priya changed this work order while you were editing. Reload to merge, or overwrite.</div>
      </Panel>
      <Panel title="Data display">
        <div className="cols">
          <div className="stack">
            <dl className="kv"><dt>Key</dt><dd>Value</dd><dt>Another</dt><dd><span className="mono">mono-value</span></dd></dl>
            <Meter value={0.62} max={1} label="Sample usage" />
            <Meter value={0.9} max={1} label="Sample usage, high" warnAt={0.85} />
            <ol className="tl">
              <li className="ok"><time>14 Nov 23:46</time><div>Approved G2</div></li>
              <li><time>14 Nov 22:56</time><div>Entered Spec</div></li>
            </ol>
          </div>
          <div className="stack">
            <div className="row"><Spark plain values={SPARK} w={100} h={28} label="Sample trend" />sparkline</div>
            <BarList label="Sample bars" labelWidth={70} items={[{ label: "Specs", value: 14 }, { label: "Plans", value: 9, tone: "warn" }, { label: "Builds", value: 4 }]} />
            <div className="heat" style={{ gridTemplateColumns: "repeat(5,1fr)" }}>
              {[0.62, 0.7, 0.8, 0.9, 0.97].map((v) => <div key={v} style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(v * 70)}%, var(--surface))` }}>{Math.round(v * 100)}</div>)}
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Floor vocabulary">
        <FloorLegend />
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
        kicker="All lines"
        sub="Every component, shown in both themes side by side: paper drawing on the left, blueprint on the right."
        actions={<Btn icon={prefs.theme === "dark" ? "sun" : "moon"} label="Toggle app theme" onClick={() => { updatePrefs({ theme: next }); applyTheme(next); }} />}
      />
      <div className="cols" style={{ alignItems: "start" }}>
        <div data-scope="light" style={SCOPE_ALIASES}>
          <h2 style={{ marginBottom: 12, fontSize: 18 }}>Paper drawing (light)</h2>
          <Gallery sc="light" />
        </div>
        <div data-scope="dark" style={SCOPE_ALIASES}>
          <h2 style={{ marginBottom: 12, fontSize: 18 }}>Blueprint (dark)</h2>
          <Gallery sc="dark" />
        </div>
      </div>
    </div>
  );
}
