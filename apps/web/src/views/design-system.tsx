/**
 * Design system (#design-system): every shared component in both themes, drawn by the same primitives the screens use.
 * A reference page, so it reads no data. Colour tokens are shown by their CSS variable so the page can never drift from the stylesheet.
 */
import { useRef, useState } from "react";
import { Card, CrIcon, Page, Spark, Stats } from "../ui/cr";
import { Btn, Chip, DataTableDemo, Donut, Field, PriTag, ProtoMeter, SamplePipe, Segmented, Select, Tabs, TextInput, Toggle } from "./design-system/parts";
import { useUI } from "../ui/overlay-context";
import { hashFor } from "../lib/router";

const TOKENS: Array<[string, string]> = [
  ["--bg", "Page"], ["--surface", "Surface"], ["--surface-2", "Surface 2"], ["--raised", "Raised"], ["--line", "Line"], ["--text", "Text"], ["--text-2", "Text 2"], ["--text-3", "Text 3"],
  ["--ok", "OK"], ["--warn", "Warn"], ["--bad", "Bad"], ["--info", "Info"], ["--agent", "Agent"], ["--accent", "Accent"],
];
const TYPE: Array<{ name: string; font: string; sample: string; label?: boolean }> = [
  { name: "Page title", font: "700 24px/32px", sample: "The belt is moving" },
  { name: "Section", font: "600 16px/24px", sample: "Needs your attention" },
  { name: "Body", font: "400 13px/20px", sample: "Agents propose, people approve." },
  { name: "Meta", font: "400 12px/16px", sample: "Requested by Meera Iyer · 3h ago" },
  { name: "Label", font: "600 11px mono caps", sample: "WORK ORDER", label: true },
];
const STATES: Array<[string, string]> = [["Loading", "loading"], ["Empty", "empty"], ["Error", "error"], ["No access", "forbidden"], ["Conflict", "conflict"]];

/** The command palette opens on Ctrl+K (the shell owns it); the button presses the same key. */
const openPalette = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

function ExampleDialogBody({ gate }: { gate: { check: () => boolean } }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  gate.check = () => {
    const v = name.trim();
    const msg = !v ? "Name is required." : v.length < 3 ? "Name needs at least 3 characters." : "";
    setErr(msg);
    if (msg) ref.current?.focus();
    return !msg;
  };
  return (
    <Field label={<>Name <span className="dim">(required)</span></>} error={err}>
      <TextInput ref={ref} name="t" value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  );
}

function Samples({ t }: { t: string }) {
  const ui = useUI();
  const [pri, setPri] = useState("P2");
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("table");
  const dialog = () => {
    const gate = { check: () => true };
    ui.dialog({
      title: "Example dialog",
      sub: "Fields validate, Esc closes, focus is trapped.",
      body: <ExampleDialogBody gate={gate} />,
      actions: [{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, onClick: (close) => { if (!gate.check()) return; close(); ui.toast("Saved", "ok"); } }],
    });
  };
  const drawer = () =>
    ui.drawer.open("ds-example", (close) => (
      <>
        <div className="drawer-h">
          <div><div className="label">Drawer</div><h2>Example drawer</h2></div>
          <button type="button" className="iconbtn drawer-close" aria-label="Close" onClick={close}><CrIcon name="x" /></button>
        </div>
        <div className="drawer-b">
          <p>Drawers show detail without leaving the page.</p>
          <dl className="kv" style={{ margin: 0 }}><dt>Key</dt><dd>Value</dd><dt>State</dt><dd><Chip text="Healthy" cls="ok" /></dd></dl>
        </div>
        <div className="drawer-f"><Btn label="Close" onClick={close} /></div>
      </>
    ));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div><div className="label" style={{ marginBottom: 8 }}>Chips</div><div className="row">
        <Chip text="Healthy" cls="ok" /><Chip text="Gate waiting" cls="warn" /><Chip text="Blocked" cls="bad" /><Chip text="Running" cls="info" /><Chip text="Agent" cls="agent" /><Chip text="Queued" cls="idle" />
        <PriTag p="P1" /><PriTag p="P2" /><PriTag p="P3" /><span className="tag">payments-api</span>
      </div></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Buttons</div><div className="row">
        <Btn kind="primary" label="Primary" /><Btn label="Default" /><Btn kind="ok" label="Approve" /><Btn kind="danger" label="Reject" /><Btn kind="ghost" label="Ghost" /><Btn small label="Small" /><Btn label="Disabled" disabled />
      </div></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Stat tiles</div>
        <Stats items={[{ l: "On belt", v: 46, d: "31 running", tone: "info", spark: [3, 5, 4, 7, 6, 9] }, { l: "Waiting", v: 12, tone: "warn" }, { l: "Blocked", v: 3, tone: "bad" }, { l: "Released", v: 18, tone: "ok" }]} />
      </div>
      <div className="grid g2">
        <div><div className="label" style={{ marginBottom: 8 }}>Fields</div><div className="stack" style={{ gap: 12 }}>
          <Field label="Title" hint="A short imperative sentence."><TextInput defaultValue="Rate limit payouts" /></Field>
          <Field label="Priority"><Select id={`ds-pri-${t}`} options={["P1", "P2", "P3"]} value={pri} onChange={setPri} /></Field>
          <Field label="With an error" error="Title needs at least 8 characters."><TextInput defaultValue="x" /></Field>
          <div className="row" style={{ gap: 8 }}><Toggle id={`ds-sw-${t}`} checked={on} onChange={setOn} label="Switch on" /><span>Switch on</span></div>
        </div></div>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Tabs and segmented control</div>
          <Tabs items={[{ id: "overview", label: "Overview" }, { id: "journey", label: "Journey" }, { id: "gates", label: "Gates", count: 3 }]} active="overview" onChange={() => undefined} idPrefix={`ds-${t}`} />
          <Segmented name={`ds-seg-${t}`} label="View" value={seg} onChange={setSeg} items={[{ id: "table", label: "Table" }, { id: "cards", label: "Cards" }]} />
          <div className="label" style={{ margin: "16px 0 8px" }}>Banner</div>
          <div className="banner warn"><CrIcon name="warn" /><div className="grow">Line halted by Sofia Rossi.</div></div>
        </div>
      </div>
      <div><div className="label" style={{ marginBottom: 8 }}>Pipeline, meter, spark, donut</div>
        <SamplePipe current={5} state="gate" />
        <div className="row" style={{ gap: 24, marginTop: 8 }}>
          <div style={{ width: 160 }}><ProtoMeter pct={72} /></div>
          <div style={{ width: 160 }}><ProtoMeter pct={92} /></div>
          <Spark data={[3, 5, 4, 7, 6, 9, 8]} />
          <Donut size={64} parts={[{ l: "a", v: 6, c: "ok" }, { l: "b", v: 3, c: "warn" }, { l: "c", v: 1, c: "bad" }]} />
        </div>
      </div>
      <div><div className="label" style={{ marginBottom: 8 }}>Floor tokens</div><div className="row" style={{ maxWidth: 520 }}>
        <div style={{ width: 96 }}><span className="tok run" style={{ display: "flex" }}><span className="id">1004</span><span className="pr p1">P1</span></span></div>
        <div style={{ width: 96 }}><span className="tok is-gate" style={{ display: "flex" }}><span className="id">1021 ⏸</span><span className="pr">P2</span></span></div>
        <div style={{ width: 96 }}><span className="tok blk" style={{ display: "flex" }}><span className="id">1033</span><span className="pr">P2</span></span></div>
        <div style={{ width: 96 }}><span className="tok que" style={{ display: "flex" }}><span className="id">1040</span><span className="pr">P3</span></span></div>
      </div></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Table</div><DataTableDemo /></div>
      <div><div className="label" style={{ marginBottom: 8 }}>Overlays and states</div><div className="row">
        <Btn label="Dialog" id={`ds-dialog-${t}`} onClick={dialog} />
        <Btn label="Drawer" id={`ds-drawer-${t}`} onClick={drawer} />
        <Btn label="Toast" id={`ds-toast-${t}`} onClick={() => ui.toast("Saved. Undo available.", "ok", { label: "Undo", onClick: () => undefined })} />
        <Btn label="Command palette" id={`ds-palette-${t}`} onClick={openPalette} />
        {STATES.map(([label, state]) => <a key={state} className="btn" href={`${hashFor("floor")}?state=${state}`}>{label}</a>)}
      </div></div>
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
          {TYPE.map(({ name, font, sample, label }) => (
            <div key={name} className="row spread" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
              <span style={label ? { font: "600 11px var(--mono)", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--text-3)" } : { font }}>{sample}</span>
              <span className="mono dim">{name} · {font}</span>
            </div>
          ))}
          <div className="mono" style={{ fontSize: 28, fontWeight: 600 }}>28 stat value 1,204 $18.40</div>
          <div className="dim">Spacing on a 4px grid: 4 8 12 16 20 24 32 40 · Control 32px (40px coarse) · Chip 20px · Row 44px</div>
        </div>
      </Card>
      <div style={{ height: 16 }} />
      <div className="grid g2" style={{ gap: 16, alignItems: "start" }}>
        {(["dark", "light"] as const).map((t) => (
          <div key={t} data-theme={t} className="ds-theme ds-samples">
            <div className="row spread" style={{ marginBottom: 12 }}><b>{t === "dark" ? "Dark" : "Light"} theme</b><span className="chip plain idle">{t}</span></div>
            <Samples t={t} />
          </div>
        ))}
      </div>
    </Page>
  );
}
