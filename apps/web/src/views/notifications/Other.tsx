/** The Repo overrides, Delivery log and Card templates tabs (legacy overridesTab, deliveriesTab, templatesTab). */
import { useEffect, useState } from "react";
import { fmt, type Delivery, type Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useDeliveries } from "../../api/queries";
import { ops } from "../../api/ops";
import { Btn, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useProjectRepos } from "../floor/kit";
import { ACTION_LABEL, DEF_TPL, DestCard, FIELDS, KIND_EVENT, TPL, WebhookCard, chanIcon, defaultTarget, evName, events, instState, targetError, usePreview, type useNtData } from "./kit";

type Nt = ReturnType<typeof useNtData>;
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/* ---------- repo overrides ---------- */

export function OverridesTab({ p, nt }: { p: Project; nt: Nt }) {
  const ui = useUI();
  const repos = useProjectRepos(p.id);
  const perm = dec(useCan("onboarding.manage", { project: p.id }));
  const ro = !perm.allowed;
  const [o, setO] = useState({ repo: "", event: "gate.waiting", integration: "", target: "", mode: "also" });
  useEffect(() => {
    setO((x) => ({
      ...x,
      repo: repos.some((r) => r.id === x.repo) ? x.repo : repos[0]?.id ?? "",
      integration: nt.destInsts.some((i) => i.id === x.integration) ? x.integration : (nt.destInsts.find((i) => i.type === "slack") ?? nt.destInsts[0])?.id ?? "",
    }));
  }, [repos, nt.destInsts]);
  const rows = repos.flatMap((r) => (r.notifyOverrides ?? []).map((x, i) => ({ repo: r, o: x, i })));
  const ctx = { project: p, instOf: nt.instOf, typeOf: nt.typeOf };
  const done = (r: { ok: boolean; msg: string }, ok: string) => ui.toast(r.ok ? ok : r.msg, r.ok ? "ok" : "error");
  const add = async () => {
    const repo = repos.find((r) => r.id === o.repo);
    if (!repo) return ui.toast("Pick a repo.", "error");
    const oi = nt.insts.find((i) => i.id === o.integration);
    const e = oi ? targetError({ channel: oi.type, target: o.target, integration: oi.id }, ctx) : "Pick a connection.";
    if (e) return ui.toast(e, "error");
    const n = (repo.notifyOverrides ?? []).reduce((m, x) => Math.max(m, Number(String(x.id || "RO-0").slice(3)) || 0), 0) + 1;
    const list = [...(repo.notifyOverrides ?? []), { id: `RO-${n}`, event: o.event, dest: [{ channel: oi!.type, target: o.target.trim(), integration: oi!.id }], template: DEF_TPL[o.event] || "submitted", mode: o.mode }];
    const r = await ops.configureRepo(repo.id, { notifyOverrides: list }, (repo as { version?: number }).version !== undefined ? { ifMatch: (repo as { version?: number }).version! } : undefined);
    done(r, `Override added to ${repo.name}.`);
    if (r.ok) setO({ ...o, target: "" });
  };
  return (
    <div className="form-grid">
      <p className="muted">A repo can add a destination to a project route (also) or replace the route's destinations for that repo (instead). Project routes still decide which events and conditions apply.</p>
      <Panel title={`Overrides on ${p.name} repos`} flush>
        <div className="table-scroll">
          <table className="table table-compact">
            <thead><tr><th>Repo</th><th>Event</th><th>Mode</th><th>Destination</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {rows.length ? rows.map((x) => (
                <tr key={`${x.repo.id}-${x.i}`}>
                  <td className="mono">{x.repo.name}</td>
                  <td>{evName(x.o.event)}</td>
                  <td><span className={`chip${x.o.mode === "instead" ? " chip-warn" : ""}`}>{x.o.mode === "instead" ? "instead of route" : "also"}</span></td>
                  <td>{(x.o.dest ?? []).map((dd, k) => { const ii = nt.instOf(dd); return <span className="nt-ov-dest" key={k}><Icon name={chanIcon(ii?.type ?? dd.channel)} /> <span className="small">{ii ? `${ii.name} ` : ""}</span><span className="mono">{dd.target}</span></span>; })}</td>
                  <td className="num"><Btn label="Remove" small kind="ghost" id={`nt-ov-rm-${x.repo.id}-${x.i}`} guard={perm} onClick={async () => {
                    const list = (x.repo.notifyOverrides ?? []).filter((_, j) => j !== x.i);
                    const v = (x.repo as { version?: number }).version;
                    done(await ops.configureRepo(x.repo.id, { notifyOverrides: list }, v !== undefined ? { ifMatch: v } : undefined), `Override removed from ${x.repo.name}.`);
                  }} /></td>
                </tr>
              )) : <tr><td colSpan={5} className="muted">No repo overrides. Every repo follows the project routes.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Add an override">
        <div className="form-grid">
          <LockNote decision={perm} what="Repo overrides" />
          <div className="form-row">
            <Field label="Repo" htmlFor="nt-ov-repo"><Select id="nt-ov-repo" options={repos.map((r) => ({ value: r.id, label: r.name }))} value={o.repo} disabled={ro} onChange={(v) => setO({ ...o, repo: v })} /></Field>
            <Field label="Event" htmlFor="nt-ov-event"><Select id="nt-ov-event" options={events()} value={o.event} disabled={ro} onChange={(v) => setO({ ...o, event: v })} /></Field>
            <Field label="Mode" htmlFor="nt-ov-mode"><Select id="nt-ov-mode" options={[{ value: "also", label: "Also send here" }, { value: "instead", label: "Send here instead" }]} value={o.mode} disabled={ro} onChange={(v) => setO({ ...o, mode: v })} /></Field>
            <Field label="Connection" htmlFor="nt-ov-channel"><Select id="nt-ov-channel" options={nt.destInsts.map((x) => ({ value: x.id, label: x.name + (instState(x) === "healthy" ? "" : ` (${instState(x)})`) }))} value={o.integration} disabled={ro} onChange={(v) => { const x = nt.insts.find((i) => i.id === v); setO({ ...o, integration: v, target: x?.type === "webhook" ? x.targetId ?? x.id : o.target }); }} /></Field>
            <Field label="Target" htmlFor="nt-ov-target"><input id="nt-ov-target" className="input mono" value={o.target} disabled={ro} placeholder="#payments-api" onChange={(e) => setO({ ...o, target: e.target.value })} /></Field>
          </div>
          <div className="form-actions"><Btn label="Add override" kind="primary" icon="plus" id="nt-ov-add" guard={perm} onClick={() => void add()} /></div>
        </div>
      </Panel>
    </div>
  );
}

/* ---------- delivery log ---------- */

export function DeliveriesTab({ p, nt }: { p: Project; nt: Nt }) {
  const ui = useUI();
  const openTraveler = useOpenTraveler();
  const perm = dec(useCan("notify.edit", { project: p.id }));
  const [f, setF] = useState({ status: "all", integration: "all", event: "all" });
  const [limit, setLimit] = useState(40);
  const q = useDeliveries({ project: p.id, limit, ...(f.status !== "all" ? { status: f.status } : {}), ...(f.integration !== "all" ? { integration: f.integration } : {}), ...(f.event !== "all" ? { event: f.event } : {}) });
  const page = Array.isArray(q.data) ? { items: q.data, next: null } : q.data ?? { items: [] as Delivery[], next: null };
  const list = page.items;
  const failedQ = useDeliveries({ project: p.id, status: "failed", limit: 200 });
  const failed = (Array.isArray(failedQ.data) ? failedQ.data : failedQ.data?.items ?? []).length;
  const instName = (d: Delivery): string => { const ii = d.integration ? nt.insts.find((i) => i.id === d.integration) : nt.instOf({ channel: d.channel, target: d.target }); return ii ? ii.name : `${d.channel}${d.integration ? " (removed)" : ""}`; };
  const retry = async (d: Delivery) => {
    const r = await ops.retryDelivery(d.id);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  return (
    <div className="form-grid">
      <div className="toolbar">
        <div className="filters">
          <Field label="Status" htmlFor="nt-dl-status"><Select id="nt-dl-status" options={[{ value: "all", label: "All" }, { value: "delivered", label: "Delivered" }, { value: "pending", label: "Pending" }, { value: "failed", label: "Failed" }]} value={f.status} onChange={(v) => { setF({ ...f, status: v }); setLimit(40); }} /></Field>
          <Field label="Connection" htmlFor="nt-dl-channel"><Select id="nt-dl-channel" options={[{ value: "all", label: "All" }, ...nt.destInsts.map((c) => ({ value: c.id, label: c.name }))]} value={f.integration} onChange={(v) => { setF({ ...f, integration: v }); setLimit(40); }} /></Field>
          <Field label="Event" htmlFor="nt-dl-event"><Select id="nt-dl-event" options={[{ value: "all", label: "All" }, ...events()]} value={f.event} onChange={(v) => { setF({ ...f, event: v }); setLimit(40); }} /></Field>
        </div>
        <div className="kv-row">
          <div><div className="kv-k">Shown</div><div className="kv-v mono">{list.length}</div></div>
          <div><div className="kv-k">Failed</div><div className={`kv-v mono${failed ? " neg" : ""}`}>{failed}</div></div>
        </div>
      </div>
      <Panel flush>
        <div className="table-scroll">
          <table className="table table-compact nt-dl">
            <thead><tr><th>Time (IST)</th><th>Id</th><th>Event</th><th>Connection</th><th>Target</th><th>Work order</th><th>Status</th><th className="num">Tries</th><th>Error</th><th><span className="sr">Retry</span></th></tr></thead>
            <tbody>
              {list.length ? list.map((d) => (
                <tr key={d.id} id={`nt-dl-${d.id}`}>
                  <td className="mono">{fmt.istDate(d.at)} {fmt.ist(d.at)}</td>
                  <td className="mono">{d.id}{d.test ? <span className="tag nt-testtag">test</span> : null}</td>
                  <td>{evName(d.event)}</td>
                  <td><Icon name={chanIcon(d.channel)} /> {instName(d)}</td>
                  <td className="mono">{d.target}</td>
                  <td>{d.wo ? <button type="button" className="linkish mono" id={`nt-dl-wo-${d.id}`} onClick={() => openTraveler(d.wo!)}>{d.wo}</button> : <span className="muted">–</span>}</td>
                  <td><span className={`outcome o-${d.status === "failed" ? "failed" : "ok"}`}>{d.status === "failed" ? (d.state === "failed" && d.attempts > 0 ? "↻ retrying" : "✕ failed") : d.status === "pending" ? "… pending" : "✓ delivered"}</span></td>
                  <td className="num mono">{d.attempts}</td>
                  <td className="small nt-err">{d.error || ""}</td>
                  <td className="num">{d.status === "failed" ? <Btn label="Retry" small icon="refresh" id={`nt-retry-${d.id}`} guard={perm} onClick={() => void retry(d)} /> : null}</td>
                </tr>
              )) : <tr><td colSpan={10} className="muted">No deliveries match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
      {page.next ? <div className="more"><Btn label="Show 40 more" id="nt-dl-more" onClick={() => setLimit(limit + 40)} /></div> : null}
      <LockNote decision={perm} what={`Retries on ${p.name}`} />
    </div>
  );
}

/* ---------- card templates ---------- */

interface CtDraft { id: string | null; name: string; kind: string; fields: string[]; actions: string[]; integration: string }

export function TemplatesTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  const ui = useUI();
  const ro = !perm.allowed;
  const rows = [...Object.keys(TPL).map((k) => nt.tplInfo(k)), ...nt.customCards.map((t) => nt.tplInfo(t.id))];
  const mk = (t: ReturnType<Nt["tplInfo"]>): CtDraft => ({ id: t.custom ? t.id : null, name: t.custom ? t.name : `${t.name} (copy)`, kind: t.kind, fields: t.fields ? [...t.fields] : FIELDS.map((f) => f[0]), actions: [...t.actions], integration: t.integration ?? "" });
  const [sel, setSel] = useState<string>(nt.customCards[0]?.id ?? rows[0]!.id);
  const [d, setD] = useState<CtDraft>(() => mk(nt.tplInfo(sel)));
  const selInfo = nt.tplInfo(sel);
  const pick = (id: string) => { setSel(id); setD(mk(nt.tplInfo(id))); };
  /** Select what the server just saved, from its own answer: the list has not refetched yet, so looking the id up would find nothing. */
  const pickSaved = (r: { template?: { id: string; name: string; kind?: string; fields?: string[]; actions?: string[]; integration?: string | null } }) => {
    const t = r.template;
    if (!t) return;
    setSel(t.id);
    setD({ id: t.id, name: t.name, kind: t.kind ?? "submitted", fields: t.fields ?? [], actions: t.actions ?? [], integration: t.integration ?? "" });
  };
  const save = async (rec: CtDraft, msg?: string) => {
    const customVersion = rec.id ? nt.customCards.find((c) => c.id === rec.id)?.version : undefined;
    void customVersion;
    const r = await ops.saveCardTemplate({ project: p.id, ...(rec.id ? { id: rec.id } : {}), name: rec.name.trim(), kind: rec.kind, fields: rec.fields, actions: rec.actions, ...(rec.integration ? { integration: rec.integration } : {}) });
    ui.toast(r.ok ? msg ?? r.msg : r.msg, r.ok ? "ok" : "error");
    return r;
  };
  const conns = nt.destInsts;
  const pvInst = (d.integration && nt.insts.find((x) => x.id === d.integration)) || conns.find((x) => x.type === "slack") || conns[0] || null;
  const fieldsObj = Object.fromEntries(FIELDS.map((f) => [f[0], d.fields.includes(f[0])]));
  const q = usePreview(p.id, { event: KIND_EVENT[d.kind] || "submitted", template: d.kind, fields: fieldsObj, actions: d.actions });
  const editing = selInfo.custom;
  const toggle = (arr: string[], v: string, on: boolean): string[] => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));
  return (
    <div className="form-grid">
      <p className="muted">Built-in cards cover each kind of event. Make your own to change which fields and buttons appear; pick one per route in the route editor.</p>
      <div className="nt-split">
        <Panel title="Templates" flush>
          <div className="dtable-wrap" id="nt-ct-table">
            <table className="dtable">
              <caption className="sr-only">Card templates</caption>
              <thead><tr><th>Template</th><th>For</th><th className="hide-sm">Buttons</th><th className="is-end">Routes, all projects</th><th /></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const used = nt.routesUsingTpl(t.id);
                  return (
                    <tr key={t.id}>
                      <td><button type="button" className={`linkish nt-ev${t.id === sel ? " is-sel" : ""}`} id={`nt-ct-open-${t.id}`} aria-pressed={t.id === sel ? "true" : "false"} onClick={() => pick(t.id)}>{t.name}</button></td>
                      <td>{t.custom ? TPL[t.kind]?.name : <span className="muted">built in</span>}</td>
                      <td className="hide-sm"><span className="small">{t.actions.map((a) => ACTION_LABEL[a]).join(", ") || "none"}</span></td>
                      <td className="is-end"><span className="mono">{used.length}</span></td>
                      <td className="is-end"><span className="nt-ct-ops">
                        <Btn label="Duplicate" small id={`nt-ct-dup-${t.id}`} guard={perm} onClick={async () => { const r = await save({ ...mk(t), id: null, name: `${t.name.replace(/ \(copy\)$/, "")} (copy)` }, "Template duplicated."); if (r.ok) pickSaved(r as never); }} />
                        {t.custom ? <Btn label="Delete" small kind="ghost" id={`nt-ct-del-${t.id}`} guard={!perm.allowed ? perm : used.length ? { allowed: false, reason: `Used by ${used.join(", ")}. Pick another card on those routes first.` } : null} onClick={() => ui.dialog({
                          title: `Delete ${t.name}?`, kicker: "Card templates", body: <p>No route uses it. It stays in the audit ledger.</p>,
                          actions: [{ label: "Cancel" }, { label: "Delete template", kind: "danger", id: "nt-ct-del-go", guard: perm, onClick: async (close) => { const r = await ops.removeCardTemplate(t.id, p.id); ui.toast(r.ok ? `${t.name} deleted.` : r.msg, r.ok ? "ok" : "error"); if (r.ok) { close(); pick(rows.find((x) => x.id !== t.id)!.id); } } }],
                        })} /> : null}
                      </span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title={editing ? `Edit ${selInfo.name}` : `New template from ${selInfo.name}`} cls="nt-ct-editor">
          <div className="form-grid">
            <LockNote decision={perm} what="Card templates" />
            <div className="form-row">
              <Field label="Name" htmlFor="nt-ct-name"><input id="nt-ct-name" className="input" value={d.name} disabled={ro} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <Field label="Card for" htmlFor="nt-ct-kind"><Select id="nt-ct-kind" options={Object.keys(TPL).map((k) => ({ value: k, label: TPL[k]!.name }))} value={d.kind} disabled={ro} onChange={(v) => setD({ ...d, kind: v })} /></Field>
              <Field label="Only on" htmlFor="nt-ct-int" hint="Optional. The preview uses this connection."><Select id="nt-ct-int" options={[{ value: "", label: "Any connection" }, ...conns.map((x) => ({ value: x.id, label: x.name }))]} value={d.integration} disabled={ro} onChange={(v) => setD({ ...d, integration: v })} /></Field>
            </div>
            <fieldset className="nt-fs">
              <legend className="field-label">Fields</legend>
              <div className="check-grid">
                {FIELDS.map((f) => <label className="check" htmlFor={`nt-ct-f-${f[0]}`} key={f[0]}><input type="checkbox" id={`nt-ct-f-${f[0]}`} checked={d.fields.includes(f[0])} disabled={ro} onChange={(e) => setD({ ...d, fields: toggle(d.fields, f[0], e.target.checked) })} />{f[1]}</label>)}
              </div>
            </fieldset>
            <fieldset className="nt-fs">
              <legend className="field-label">Buttons</legend>
              <div className="check-grid">
                {Object.keys(ACTION_LABEL).map((a) => <label className="check" htmlFor={`nt-ct-a-${a}`} key={a}><input type="checkbox" id={`nt-ct-a-${a}`} checked={d.actions.includes(a)} disabled={ro} onChange={(e) => setD({ ...d, actions: toggle(d.actions, a, e.target.checked) })} />{ACTION_LABEL[a]}</label>)}
              </div>
            </fieldset>
            <div className="form-actions">
              <Btn label={editing ? "Revert" : "Reset"} id="nt-ct-revert" onClick={() => setD(mk(selInfo))} />
              <Btn label={editing ? "Save template" : "Create template"} kind="primary" id="nt-ct-save" guard={perm} onClick={async () => {
                if (!d.name.trim()) return ui.toast("Name the card.", "error");
                const r = await save(editing ? { ...d, id: selInfo.id } : { ...d, id: null });
                if (r.ok) pickSaved(r as never);
              }} />
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Preview" cls="nt-ct-preview">
        <div className="nt-stage">
          {q.data ? (pvInst ? <DestCard pv={q.data} fields={fieldsObj} dest={{ channel: pvInst.type, target: defaultTarget(pvInst.type, p, pvInst) || "target", integration: pvInst.id }} inst={pvInst} route={null} /> : <WebhookCard pv={q.data} target="payload" inst={null} />) : <p className="muted small">{q.isError ? "The preview could not be drawn." : "Drawing the preview…"}</p>}
        </div>
      </Panel>
      {!rows.length ? <Empty title="No templates" /> : null}
    </div>
  );
}
