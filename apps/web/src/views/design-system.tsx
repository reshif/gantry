/**
 * Design system (#design-system): every shared component in both themes, drawn by the same primitives the screens use.
 * A reference page, so it reads no data. Colour tokens are shown by their CSS variable so the page can never drift from the stylesheet.
 */
import { useState } from "react";
import { Bars, Card, CrIcon, Page, Spark, Stats } from "../ui/cr";
import { Btn, Chip, DataTableDemo, Empty, Field, Meter, Segmented, Select, StatusChip, Tabs, Toggle } from "./design-system/parts";
import { useUI } from "../ui/overlay-context";

const TOKENS: Array<[string, string]> = [
  ["--bg", "Page"], ["--surface", "Surface"], ["--surface-2", "Surface 2"], ["--raised", "Raised"], ["--line", "Line"], ["--text", "Text"], ["--text-2", "Text 2"], ["--text-3", "Text 3"],
  ["--ok", "OK"], ["--warn", "Warn"], ["--bad", "Bad"], ["--info", "Info"], ["--agent", "Agent"], ["--accent", "Accent"],
];
const TYPE: Array<[string, string, string]> = [
  ["Page title", "700 24px/32px", "The belt is moving"],
  ["Section", "600 16px/24px", "Needs your attention"],
  ["Body", "400 13px/20px", "Agents propose, people approve."],
  ["Meta", "400 12px/16px", "Requested by Meera Iyer, 3h ago"],
];

function Samples() {
  const ui = useUI();
  const [tab, setTab] = useState("overview");
  const [seg, setSeg] = useState("table");
  const [on, setOn] = useState(true);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div><div className="label" style={{ marginBottom: 8 }}>Chips</div><div className="row">
        <Chip text="Healthy" cls="ok" /><Chip text="Gate waiting" cls="warn" /><Chip text="Blocked" cls="bad" /><Chip text="Running" cls="info" /><Chip text="Agent" cls="agent" /><Chip text="Queued" cls="idle" />
        <StatusChip tone="done">Released</StatusChip>
      </div></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Buttons</div><div className="row">
        <Btn kind="primary" label="Primary" /><Btn label="Default" /><Btn kind="ok" label="Approve" /><Btn kind="danger" label="Reject" /><Btn kind="ghost" label="Ghost" /><Btn small label="Small" /><Btn label="Disabled" disabledReason="Not allowed here" />
      </div></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Stat tiles</div>
        <Stats items={[{ l: "On belt", v: 46, d: "31 running", tone: "info", spark: [3, 5, 4, 7, 6, 9] }, { l: "Waiting", v: 12, tone: "warn" }, { l: "Blocked", v: 3, tone: "bad" }, { l: "Released", v: 18, tone: "ok" }]} />
      </div>
      <div className="grid g2">
        <div><div className="label" style={{ marginBottom: 8 }}>Fields</div><div className="stack" style={{ gap: 12 }}>
          <Field label="Priority" hint="How soon it should run."><Select id="ds-pri" options={["P1", "P2", "P3"]} value="P2" /></Field>
          <Field label="With an error" error="Title needs at least 8 characters."><Select id="ds-err" options={["x"]} value="x" /></Field>
          <Toggle id="ds-sw" checked={on} onChange={setOn} label="Switch" />
        </div></div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Tabs and segmented control</div>
          <Tabs items={[{ id: "overview", label: "Overview" }, { id: "journey", label: "Journey" }, { id: "gates", label: "Gates", count: 3 }]} active={tab} onChange={setTab} idPrefix="ds" />
          <Segmented name="ds-seg" label="View" value={seg} onChange={setSeg} items={[{ id: "table", label: "Table" }, { id: "cards", label: "Cards" }]} />
          <div className="label" style={{ margin: "16px 0 8px" }}>Banner</div>
          <div className="banner warn"><CrIcon name="warn" /><div className="grow">Line halted by Sofia Rossi.</div></div>
        </div>
      </div>
      <div><div className="label" style={{ marginBottom: 8 }}>Meter, spark, bars</div>
        <div className="row" style={{ gap: 24 }}><div style={{ width: 160 }}><Meter value={72} max={100} /></div><div style={{ width: 160 }}><Meter value={92} max={100} /></div><Spark data={[3, 5, 4, 7, 6, 9, 8]} /><div style={{ width: 160 }}><Bars data={[3, 5, 4, 7, 6, 9, 8]} h={64} label="Throughput" /></div></div>
      </div>
      <div><div className="label" style={{ marginBottom: 8 }}>Table</div><DataTableDemo /></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Overlays and states</div><div className="row">
        <Btn label="Dialog" onClick={() => ui.dialog({ title: "Example dialog", sub: "Esc closes, focus is trapped.", body: <p>Dialogs hold one decision.</p>, actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", onClick: (c) => { c(); ui.toast("Saved", "ok"); } }] })} />
        <Btn label="Toast" onClick={() => ui.toast("Saved. Undo available.", "ok", { label: "Undo", onClick: () => undefined })} />
        <Btn label="Toast (error)" onClick={() => ui.toast("Could not save.", "error")} />
      </div><div style={{ marginTop: 12 }}><Empty title="Nothing here yet" text="When there is something to show it will appear here." /></div></div>
    </div>
  );
}

export default function DesignSystemView() {
  return (
    <Page eyebrow="Reference" title="Design system" sub="Every component, in both themes, using the same tokens the app uses.">
      <Card title="Colour tokens">
        <div className="grid g2" style={{ gap: 16 }}>
          {(["dark", "light"] as const).map((t) => (
            <div key={t} data-theme={t} className="ds-theme">
              <div className="label" style={{ marginBottom: 8 }}>{t}</div>
              <div className="sw-grid">{TOKENS.map(([v, l]) => <div key={v} className="sw" style={{ background: `var(${v})`, color: /^--(ok|warn|bad|info|agent|accent|text|text-2|text-3)$/.test(v) && !v.startsWith("--text") ? "var(--on-accent,#000)" : v.startsWith("--text") ? "var(--bg)" : "var(--text-2)" }}><span>{l}</span></div>)}</div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Type scale">
        <div className="stack" style={{ gap: 12 }}>
          {TYPE.map(([name, font, sample]) => (
            <div key={name} className="row spread" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <span style={{ font }}>{sample}</span><span className="mono dim">{name} / {font}</span>
            </div>
          ))}
          <div className="mono" style={{ fontSize: 28, fontWeight: 600 }}>28 stat value 1,204 $18.40</div>
          <div className="dim">Spacing on a 4px grid: 4 8 12 16 20 24 32 40. Control 32px (40px coarse), chip 20px, row 44px.</div>
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <div className="grid g2" style={{ gap: 16, alignItems: "start" }}>
        {(["dark", "light"] as const).map((t) => (
          <div key={t} data-theme={t} className="ds-theme ds-samples">
            <div className="row spread" style={{ marginBottom: 12 }}><b>{t === "dark" ? "Dark" : "Light"} theme</b><span className="chip plain idle">{t}</span></div>
            <Samples />
          </div>
        ))}
      </div>
    </Page>
  );
}
