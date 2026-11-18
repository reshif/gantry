/** The Routes tab: routes of one project (event, destinations, card, conditions), the route editor and the card designer (legacy routesTab, editor, designer). */
import { useEffect, useMemo, useState } from "react";
import { ops } from "../../api/ops";
import { Btn, Empty, Field, LockNote, Panel, Segmented, Select, Toggle, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { ListView } from "../connect/kit";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { ClassChip, useCatalog } from "../projects/kit";
import type { Project, WorkClass } from "@gantry/domain";
import { ALL_FIELDS, DEF_TPL, DestCard, FIELDS, WebhookCard, accepts, chanIcon, defaultTarget, draftError, evName, events, instState, usePreview, type Dest, type Draft, type Route, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const norm = (r: Route | Draft): Draft => ({ ...(clone(r) as Draft), id: r.id ?? null, fields: { ...ALL_FIELDS, ...(r.fields ?? {}) }, cond: { ...(r.cond ?? {}), classes: r.cond?.classes ?? [], priority: r.cond?.priority ?? [], hours: r.cond?.hours ?? "any" } });

const CHANNELS = ["slack", "teams", "email", "webhook", "paging"];

/** The prototype's "Add a route" dialog: When, Channel, Send to. The card and conditions are edited from the row afterwards. */
function AddRoute({ p, nt, perm, close }: { p: Project; nt: Nt; perm: Decision; close: () => void }) {
  const ui = useUI();
  const [v, setV] = useState({ event: events()[0]?.value ?? "gate.waiting", channel: "slack", target: "" });
  const [err, setErr] = useState<{ field: "target" | "channel"; msg: string } | null>(null);
  const save = async (): Promise<void> => {
    const inst = nt.destInsts.find((i) => i.type === v.channel && i.connected) ?? nt.destInsts.find((i) => i.type === v.channel);
    if (!inst) return setErr({ field: "channel", msg: `No ${v.channel} connection is open to ${p.name}. Connect one in Integrations first.` });
    const target = v.target.trim() || (inst.type === "webhook" ? inst.targetId || inst.id : "");
    if (target.length < 2) return setErr({ field: "target", msg: "Send to is required." });
    const e = draftError({ dest: [{ channel: inst.type, target, integration: inst.id }] }, { project: p, instOf: nt.instOf, typeOf: nt.typeOf });
    if (e) return setErr({ field: "target", msg: e });
    const r = await ops.saveRoute(p.id, null, { event: v.event, dest: [{ channel: inst.type, target, integration: inst.id }], template: DEF_TPL[v.event] || "submitted", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: { ...ALL_FIELDS } });
    if (!r.ok) return setErr({ field: "target", msg: r.msg });
    ui.toast("Route added", "ok");
    close();
  };
  return (
    <Dialog title="Add a route" kicker={p.name} onClose={close} actions={[{ label: "Cancel" }, { label: "Save", kind: "primary", submit: true, id: "nt-add-go", guard: perm, onClick: () => void save() }]} body={(
      <div className="form-grid">
        <Field label="When" htmlFor="nt-add-event"><Select id="nt-add-event" options={events()} value={v.event} onChange={(x) => setV({ ...v, event: x })} /></Field>
        <Field label="Channel" htmlFor="nt-add-channel" error={err?.field === "channel" ? err.msg : undefined}><Select id="nt-add-channel" options={CHANNELS} value={v.channel} onChange={(x) => { setV({ ...v, channel: x }); setErr(null); }} /></Field>
        <Field label="Send to (required)" htmlFor="nt-add-target" hint="A channel, a person or an address." error={err?.field === "target" ? err.msg : undefined}>
          <input id="nt-add-target" className="input mono" value={v.target} placeholder="#channel or address" onChange={(e) => setV({ ...v, target: e.target.value })} />
        </Field>
      </div>
    )} />
  );
}

export function RoutesTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  const ui = useUI();
  const list = nt.routes as Route[];
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState("d0");
  // The selection follows the data: a deleted route, or a project switch, falls back to none.
  useEffect(() => {
    if (sel !== null && sel !== "new" && !list.some((r) => r.id === sel)) setSel(null);
  }, [list, sel]);
  const cur = sel === "new" ? null : list.find((r) => r.id === sel) ?? null;
  useEffect(() => {
    if (sel === "new") {
      const first = nt.destInsts.find((i) => i.type === "slack" && i.connected) ?? nt.destInsts[0];
      setDraft({ id: null, event: "blocked", dest: first ? [{ channel: first.type, target: defaultTarget(first.type, p, first), integration: first.id }] : [], template: "incident", cond: { classes: [], priority: [], hours: "any" }, enabled: true, fields: { ...ALL_FIELDS } });
    } else setDraft(cur ? norm(cur) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, cur?.id, cur?.version, JSON.stringify(cur), p.id]);

  const select = (id: string | null) => { setSel(id); setPreview("d0"); };
  const toggleRoute = async (r: Route, v: boolean) => {
    const res = await ops.saveRoute(p.id, r.id, { enabled: v }, nt.versions.get(r.id) !== undefined ? { ifMatch: nt.versions.get(r.id)! } : undefined);
    ui.toast(res.ok ? (v ? "Route enabled" : "Route paused") : res.msg, res.ok ? "ok" : "error");
  };
  const locked = (_r: Route): Decision | null => (!perm.allowed ? perm : null);
  const MANDATORY = "Kill and restore notifications cannot be switched off or removed.";
  const mandatoryRoute = (r: Route): boolean => r.event === "kill" || r.event === "restore";
  const remove = (r: Route): void => {
    ui.dialog({
      title: "Remove this route?", kicker: p.name, body: <p>People will stop hearing about {r.event}.</p>,
      actions: [{ label: "Cancel" }, { label: "Remove", kind: "danger", id: "nt-rm-go", guard: perm, onClick: async (close) => {
        const res = await ops.deleteRoute(p.id, r.id, nt.versions.get(r.id) !== undefined ? { ifMatch: nt.versions.get(r.id)! } : undefined);
        ui.toast(res.ok ? "Route removed" : res.msg, res.ok ? "ok" : "error");
        if (res.ok) { close(); if (sel === r.id) select(null); }
      } }],
    });
  };
  const condText = (r: Route): string => {
    const c: string[] = [...r.cond.classes, ...r.cond.priority];
    return c.length ? c.join(", ") : "Always";
  };
  return (
    <div className="stack nt-routes">
      <Panel title={`Who hears about what, in ${p.name}`} flush id="nt-routes-panel" tools={<Btn label="Add route" small icon="plus" kind="primary" id="nt-add" guard={perm} onClick={() => ui.open((close) => <AddRoute p={p} nt={nt} perm={perm} close={close} />)} />}>
        <ListView<Route>
          id="routes" noun="route" rows={list} rowKey={(r) => r.id} rowId={(r) => `nt-row-${r.id}`} onRow={(r) => select(r.id)} rowLabel={(r) => `Edit route ${r.id}`}
          text={(r) => `${r.event} ${evName(r.event)} ${r.dest.map((d) => d.target + d.channel).join(" ")}`}
          filters={[{ key: "channel", label: "Channel", options: CHANNELS, test: (r, v) => r.dest.some((d) => d.channel === v) }]}
          empty={<Empty title="No routes yet" text="Add a route to start sending notifications." />}
          columns={[
            { key: "e", label: "Event", sort: (r) => r.event, render: (r) => <div><b>{evName(r.event)}</b><span className="sub mono">{r.event}</span></div> },
            { key: "d", label: "Sent to", render: (r) => (
              <div className="row">
                {r.dest.map((d, i) => {
                  const st = instState(nt.instOf(d));
                  return <span key={i} className={`chip plain${st !== "healthy" ? " bad" : ""}`} title={st !== "healthy" ? st : undefined}>{d.channel} · {d.target}</span>;
                })}
              </div>
            ) },
            { key: "c", label: "Condition", render: condText },
            { key: "on", label: "On", render: (r) => <Toggle id={`nt-en-${r.id}`} checked={r.enabled} decision={locked(r)} label="Enabled" onChange={(v) => { if (mandatoryRoute(r)) ui.toast(MANDATORY, "warn"); else void toggleRoute(r, v); }} /> },
            { key: "x", label: "", align: "end", render: (r) => (
              <Btn small kind="ghost" cls="icon" icon="trash" aria="Remove route" id={`nt-rm-${r.id}`} guard={locked(r)} onClick={() => { if (mandatoryRoute(r)) ui.toast(MANDATORY, "warn"); else remove(r); }} />
            ) },
          ]}
        />
      </Panel>
      {sel !== null ? <div className="nt-split"><Editor p={p} nt={nt} perm={perm} cur={cur} draft={draft} setDraft={setDraft} onSaved={select} /></div> : null}
      {sel !== null && draft ? <Designer p={p} nt={nt} perm={perm} draft={draft} setDraft={setDraft} preview={preview} setPreview={setPreview} /> : null}
    </div>
  );
}

function Editor({ p, nt, perm, cur, draft, setDraft, onSaved }: { p: Project; nt: Nt; perm: Decision; cur: Route | null; draft: Draft | null; setDraft: (d: Draft | null) => void; onSaved: (id: string | null) => void }) {
  const ui = useUI();
  const cat = useCatalog();
  const [err, setErr] = useState("");
  if (!draft) return <Panel title="Route"><Empty title="No routes" text="This project sends no notifications yet. Add a route to start." /></Panel>;
  const ro = !perm.allowed;
  const d = draft;
  const dirty = !d.id || (cur ? JSON.stringify(norm(cur)) !== JSON.stringify(d) : true);
  const classes: WorkClass[] = (p.flow?.classes ?? cat?.classes ?? []) as WorkClass[];
  const mandatory = d.event === "kill" || d.event === "restore";
  const upd = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  const setDest = (i: number, patch: Partial<Dest>) => upd({ dest: d.dest.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
  const toggleIn = (arr: string[], v: string, on: boolean): string[] => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));
  const refuse = d.dest.map((x) => nt.instOf(x)).filter((x) => x && !accepts(nt.typeOf(x.type), d.event)) as NonNullable<ReturnType<Nt["instOf"]>>[];
  const ctx = { project: p, instOf: nt.instOf, typeOf: nt.typeOf };
  const tpl = nt.tplInfo(d.template);
  const save = async () => {
    const e = draftError(d, ctx);
    if (e) { setErr(e); ui.toast(e, "error"); return; }
    setErr("");
    const body = {
      event: d.event, dest: d.dest.map((x) => { const inst = nt.instOf(x); return { channel: inst ? inst.type : x.channel, target: x.target.trim(), ...(inst ? { integration: inst.id } : {}) }; }),
      template: d.template, cond: d.cond, enabled: d.enabled, fields: d.fields,
    };
    const r = await ops.saveRoute(p.id, d.id, body, d.id && nt.versions.get(d.id) !== undefined ? { ifMatch: nt.versions.get(d.id)! } : undefined);
    ui.toast(r.msg, r.ok ? "ok" : "error");
    if (!r.ok) setErr(r.msg);
    else onSaved(String((r as unknown as { id: string }).id));
  };
  const del = () => ui.dialog({
    title: `Delete route ${d.id}?`, kicker: p.name, body: <p>{evName(d.event)} events will no longer go to {d.dest.map((x) => x.target).join(", ")}.</p>,
    actions: [{ label: "Cancel" }, { label: "Delete route", kind: "danger", id: "nt-del-go", guard: perm, onClick: async (close) => {
      const r = await ops.deleteRoute(p.id, d.id!, nt.versions.get(d.id!) !== undefined ? { ifMatch: nt.versions.get(d.id!)! } : undefined);
      ui.toast(r.ok ? `Route ${d.id} deleted.` : r.msg, r.ok ? "ok" : "error");
      if (r.ok) { close(); onSaved(null); }
    } }],
  });
  const sendTest = async (x: Dest) => {
    const e = draftError({ dest: [x] }, ctx);
    if (e) return ui.toast(e, "error");
    const inst = nt.instOf(x);
    const r = await ops.sendTest(p.id, { channel: inst?.type ?? x.channel, target: x.target.trim(), integration: x.integration || inst?.id || null }, "", d.event);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  const title = (
    <span>{d.id ? `Route ${d.id}` : "New route"}{dirty && d.id ? <span className="chip chip-warn nt-dirty">unsaved</span> : null}</span>
  );
  return (
    <Panel title={title} cls="nt-editor">
      <div className="form-grid">
        <LockNote decision={perm} what={`Notification routes on ${p.name}`} />
        <div className="form-row">
          <Field label="Event" htmlFor="nt-event"><Select id="nt-event" options={events()} value={d.event} disabled={ro} onChange={(v) => upd({ event: v, template: DEF_TPL[v] || d.template })} /></Field>
          <Field label="Card template" htmlFor="nt-template" hint={tpl.custom ? "Custom template. Its fields are copied into the toggles below." : undefined}>
            <Select id="nt-template" options={nt.tplOptions(d.template)} value={d.template} disabled={ro} onChange={(v) => {
              const ti = nt.tplInfo(v);
              const fields = { ...d.fields } as Record<string, boolean>;
              if (ti.custom && ti.fields) for (const f of FIELDS) fields[f[0]] = ti.fields.includes(f[0]);
              upd({ template: v, fields: fields as Draft["fields"] });
            }} />
          </Field>
        </div>
        {mandatory ? <div className="callout callout-block" id="nt-mandatory"><Icon name="lock" /><span>Kill and restore notifications cannot be switched off or narrowed. They go out through every route, even when a connection is off.</span></div> : null}
        {refuse.length ? (
          <div className="callout callout-warn" role="note" id="nt-refuse"><Icon name="alert" /><span>{refuse.map((x) => x.name).join(", ")} only accept{refuse.length === 1 ? "s" : ""} {(nt.typeOf(refuse[0]!.type).events ?? []).map(evName).join(", ")}. This event is not delivered there.</span></div>
        ) : null}
        <fieldset className="nt-fs">
          <legend className="field-label">Destinations</legend>
          {nt.destInsts.length ? null : <p className="muted small">No connection with notify capability is open to {p.name}. <a href="#integrations" className="linkish" id="nt-to-int">Add one in Integrations</a>.</p>}
          <ul className="nt-destlist">
            {d.dest.map((x, i) => {
              const inst = nt.instOf(x);
              const st = instState(inst);
              const opts = nt.destInsts.map((v) => ({ value: v.id, label: v.name + (instState(v) === "healthy" ? "" : ` (${instState(v)})`) }));
              if (inst && !nt.destInsts.some((v) => v.id === inst.id)) opts.unshift({ value: inst.id, label: `${inst.name} (not open to ${p.key})` });
              if (!inst) opts.unshift({ value: "", label: "Pick a connection" });
              return (
                <li className="nt-destrow" key={i}>
                  <Select id={`nt-dest-c-${i}`} options={opts} value={inst?.id ?? ""} disabled={ro} aria-label="Connection" onChange={(v) => {
                    const ni = nt.insts.find((z) => z.id === v);
                    if (!ni) return;
                    const keep = ni.type === x.channel && ni.type !== "webhook";
                    setDest(i, { integration: ni.id, channel: ni.type, ...(keep ? {} : { target: defaultTarget(ni.type, p, ni) }) });
                  }} />
                  <input id={`nt-dest-t-${i}`} className="input mono" {...(inst?.type === "webhook"
                    ? { value: inst.targetId || inst.id, readOnly: true, "aria-label": "Webhook endpoint id", title: typeof inst.config.url === "string" ? inst.config.url : "" }
                    : { value: x.target, disabled: ro, "aria-label": nt.typeOf(x.channel).targetLabel || "Target", placeholder: x.channel === "slack" ? "#channel or @person" : x.channel === "email" ? "address or submitter" : nt.typeOf(x.channel).targetLabel || "Target", onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDest(i, { target: e.target.value }) })} />
                  {st === "healthy" ? null : <span className="chip chip-warn" title={inst ? `${inst.name} is ${st}` : "No connection"}><Icon name="plug" />{st}</span>}
                  <Btn label="Send test" small icon="send" id={`nt-test-${i}`} guard={!d.id ? { allowed: false, reason: "Save the route before sending a test." } : perm} onClick={() => void sendTest(x)} />
                  <Btn small kind="ghost" icon="x" aria={`Remove destination ${i + 1}`} id={`nt-dest-rm-${i}`} guard={ro ? perm : d.dest.length < 2 ? { allowed: false, reason: "A route needs at least one destination." } : null} onClick={() => upd({ dest: d.dest.filter((_, n) => n !== i) })} />
                </li>
              );
            })}
          </ul>
          <Btn label="Add destination" small icon="plus" id="nt-dest-add" guard={!perm.allowed ? perm : nt.destInsts.length ? null : { allowed: false, reason: `No connection is open to ${p.name}.` }} onClick={() => {
            const used = d.dest.map((x) => x.integration);
            const ni = nt.destInsts.find((x) => !used.includes(x.id) && x.type === "email") ?? nt.destInsts.find((x) => !used.includes(x.id)) ?? nt.destInsts[0]!;
            upd({ dest: [...d.dest, { channel: ni.type, target: ni.type === "email" ? "approvers" : defaultTarget(ni.type, p, ni), integration: ni.id }] });
          }} />
        </fieldset>
        <fieldset className="nt-fs">
          <legend className="field-label">Conditions (empty means every)</legend>
          <div className="nt-sub">Class</div>
          <div className="check-grid nt-checks">
            {classes.map((c) => (
              <label className="check" htmlFor={`nt-cls-${c.id}`} key={c.id}>
                <input type="checkbox" id={`nt-cls-${c.id}`} checked={d.cond.classes.includes(c.id)} disabled={ro || mandatory} onChange={(e) => upd({ cond: { ...d.cond, classes: toggleIn(d.cond.classes, c.id, e.target.checked) } })} />
                <ClassChip cls={c} small />
              </label>
            ))}
          </div>
          <div className="nt-cond2">
            <div>
              <div className="nt-sub">Priority</div>
              <div className="nt-inline">
                {["P1", "P2", "P3"].map((pr) => (
                  <label className="check" htmlFor={`nt-prio-${pr}`} key={pr}>
                    <input type="checkbox" id={`nt-prio-${pr}`} checked={d.cond.priority.includes(pr)} disabled={ro || mandatory} onChange={(e) => upd({ cond: { ...d.cond, priority: toggleIn(d.cond.priority, pr, e.target.checked) } })} />
                    <span className="mono">{pr}</span>
                  </label>
                ))}
              </div>
            </div>
            <Field label="Hours" htmlFor="nt-hours"><Select id="nt-hours" options={[{ value: "any", label: "Any time" }, { value: "business", label: "Business hours, 09:00 to 19:00 plant time" }]} value={d.cond.hours} disabled={ro || mandatory} onChange={(v) => upd({ cond: { ...d.cond, hours: v as "any" | "business" } })} /></Field>
          </div>
        </fieldset>
        <div className="form-err" role="alert" id="nt-err">{err}</div>
        <div className="form-actions nt-actions">
          {d.id ? <Btn label="Delete route" kind="ghost" id="nt-del" guard={!perm.allowed ? perm : mandatory ? { allowed: false, reason: "Kill and restore routes cannot be removed. Change where they go instead." } : null} onClick={del} /> : null}
          {dirty && d.id ? <Btn label="Revert" id="nt-revert" onClick={() => setDraft(cur ? norm(cur) : null)} /> : null}
          {dirty && !d.id ? <Btn label="Discard" id="nt-discard" onClick={() => onSaved(null)} /> : null}
          <Btn label={d.id ? "Save route" : "Create route"} kind="primary" id="nt-save" guard={perm.allowed && !dirty ? { allowed: false, reason: "No changes to save." } : perm} onClick={() => void save()} />
        </div>
      </div>
    </Panel>
  );
}

function Designer({ p, nt, perm, draft, setDraft, preview, setPreview }: { p: Project; nt: Nt; perm: Decision; draft: Draft; setDraft: (d: Draft) => void; preview: string; setPreview: (v: string) => void }) {
  const ui = useUI();
  const ro = !perm.allowed;
  const d = draft;
  const items = useMemo(() => [...d.dest.map((x, i) => { const inst = nt.instOf(x); return { id: `d${i}`, label: inst ? inst.name : x.channel, icon: chanIcon(inst?.type ?? x.channel), dest: x, inst }; }), { id: "json", label: "JSON payload", icon: "webhook", dest: null as Dest | null, inst: null as ReturnType<Nt["instOf"]> }], [d.dest, nt]);
  const pv = items.find((x) => x.id === preview) ?? items[0]!;
  const q = usePreview(p.id, { event: d.event, template: d.template, fields: d.fields });
  const testAll = async () => {
    let ok = 0;
    const bad: string[] = [];
    for (const x of d.dest) {
      const inst = nt.instOf(x);
      const r = await ops.sendTest(p.id, { channel: inst?.type ?? x.channel, target: x.target.trim(), integration: x.integration || inst?.id || null }, "", d.event);
      if (r.ok) ok++; else bad.push(x.target);
    }
    ui.toast(`${ok} test${ok === 1 ? "" : "s"} queued${bad.length ? `, failed: ${bad.join(", ")}` : ""}. See the delivery log.`, bad.length ? "warn" : "ok");
  };
  return (
    <Panel title="Card designer" cls="nt-designer-panel">
      <div className="nt-designer">
        <div className="nt-fields">
          <div className="nt-sub">Fields on the card</div>
          {FIELDS.map((f) => (
            <label className="toggle-row" htmlFor={`nt-fld-${f[0]}`} key={f[0]}>
              <span>{f[1]}</span>
              <Toggle id={`nt-fld-${f[0]}`} checked={(d.fields as Record<string, boolean>)[f[0]] !== false} decision={ro ? perm : null} onChange={(v) => setDraft({ ...d, fields: { ...d.fields, [f[0]]: v } })} />
            </label>
          ))}
          <p className="footnote">Toggles change the draft. Save the route to keep them.</p>
          <Btn label="Send test to all destinations" icon="send" id="nt-test-all" guard={!d.id ? { allowed: false, reason: "Save the route before sending a test." } : perm} onClick={() => void testAll()} />
        </div>
        <div className="nt-preview">
          <Segmented name="nt-pv" items={items.map((x) => ({ id: x.id, label: x.label, icon: x.icon }))} value={pv.id} onChange={setPreview} label="Preview destination" />
          <div className="nt-stage">
            {q.data ? (pv.dest ? <DestCard pv={q.data} fields={d.fields} dest={pv.dest} inst={pv.inst} route={d.id} /> : <WebhookCard pv={q.data} target="payload" inst={null} />) : <p className="muted small">{q.isError ? "The preview could not be drawn." : "Drawing the preview…"}</p>}
          </div>
          <p className="footnote">Preview uses live sample data from {p.name}. It is the card Gantry sends; nothing is sent by looking at it.</p>
        </div>
      </div>
    </Panel>
  );
}
