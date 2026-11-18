/** The Repo overrides, Delivery log and Card templates tabs (legacy overridesTab, deliveriesTab, templatesTab). */
import { useEffect, useState } from "react";
import { Async } from "../../ui/async";
import { type Delivery, type Project } from "@gantry/domain";
import { useCan } from "../../api/can";
import { useDeliveries } from "../../api/queries";
import { ops } from "../../api/ops";
import { Btn, Empty, Field, LockNote, Panel, Select, type Decision } from "../../ui/primitives";
import { ListView, ago } from "../connect/kit";
import { hashFor } from "../../lib/router";
import { useUI } from "../../ui/overlay-context";
import { useOpenTraveler } from "../../shell/useTraveler";
import { useProjectRepos } from "../floor/kit";
import { ACTION_LABEL, ALL_FIELDS, DEF_TPL, DestCard, FIELDS, KIND_EVENT, TPL, WebhookCard, defaultTarget, events, instState, targetError, usePreview, type useNtData } from "./kit";

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
    <div className="stack">
      <Panel title="Repos that change the routes" flush id="nt-overrides">
        {rows.length ? (
          <ul className="list">
            {rows.map((x) => (
              <li key={`${x.repo.id}-${x.i}`}>
                <a className="pri" href={hashFor("onboarding", x.repo.id, p.id)}>{x.repo.name}</a>
                <div className="grow small muted">{x.o.event} → {(x.o.dest ?? []).map((dd) => `${nt.instOf(dd)?.type ?? dd.channel} ${dd.target}`).join(", ")}</div>
                <span className="chip info">{x.o.mode === "instead" ? "instead" : "also"}</span>
                <Btn label="Remove" small kind="ghost" id={`nt-ov-rm-${x.repo.id}-${x.i}`} guard={perm} onClick={async () => {
                  const list = (x.repo.notifyOverrides ?? []).filter((_, j) => j !== x.i);
                  const v = (x.repo as { version?: number }).version;
                  done(await ops.configureRepo(x.repo.id, { notifyOverrides: list }, v !== undefined ? { ifMatch: v } : undefined), `Override removed from ${x.repo.name}.`);
                }} />
              </li>
            ))}
          </ul>
        ) : <Empty title="No overrides" text="Repos use the project routes." />}
      </Panel>
      <Panel title="Add an override">
        <div className="form-grid">
          <LockNote decision={perm} what="Repo overrides" />
          <p className="muted small">A repo can add a destination to a project route (also) or replace the route's destinations for that repo (instead).</p>
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
  const [limit, setLimit] = useState(200);
  // the log is across every project (as in the prototype); retries are checked against the delivery's own project by the server
  const q = useDeliveries({ limit });
  const page = Array.isArray(q.data) ? { items: q.data, next: null } : q.data ?? { items: [] as Delivery[], next: null };
  const list = page.items;
  const retry = async (d: Delivery) => {
    const r = await ops.retryDelivery(d.id);
    ui.toast(r.ok ? "Delivered on retry" : r.msg, r.ok ? "ok" : "error");
  };
  const tone = (s: string): string => (s === "delivered" ? "ok" : s === "failed" ? "bad" : "warn");
  return (
    <div className="stack">
      <Async query={q} what="the delivery log" id="nt-dl">{() => (
        <Panel title="Deliveries" flush id="nt-deliveries">
          <ListView<Delivery>
            id="dlv" noun="delivery" rows={list} rowKey={(d) => d.id} rowId={(d) => `nt-dl-${d.id}`}
            text={(d) => `${d.event} ${d.target} ${d.channel} ${nt.projects.find((x) => x.id === d.project)?.name ?? d.project ?? ""}`}
            filters={[
              { key: "status", label: "Status", options: ["delivered", "failed", "pending"] },
              { key: "channel", label: "Channel", options: ["slack", "email", "teams", "webhook", "paging"] },
            ]}
            columns={[
              { key: "id", label: "Id", render: (d) => <span className="mono">{d.id}{d.test ? <span className="tag nt-testtag">test</span> : null}</span> },
              { key: "at", label: "When", sort: (d) => d.at, render: (d) => ago(d.at) },
              { key: "event", label: "Event", render: (d) => (
                <div>{d.event}{d.wo ? <span className="sub"><button type="button" className="linkish mono" id={`nt-dl-wo-${d.id}`} onClick={() => openTraveler(d.wo!)}>{d.wo}</button></span> : null}</div>
              ) },
              { key: "to", label: "To", render: (d) => `${d.channel} \u00b7 ${d.target}` },
              { key: "project", label: "Project", render: (d) => nt.projects.find((x) => x.id === d.project)?.name ?? d.project ?? "\u2014" },
              { key: "status", label: "Status", render: (d) => (
                <div><span className={`chip ${tone(d.status)}`}>{d.status}</span>{d.status !== "delivered" && (d.error || d.attempts) ? <span className="sub nt-err">{d.attempts ? `${d.attempts} ${d.attempts === 1 ? "try" : "tries"}` : ""}{d.error ? ` \u00b7 ${d.error}` : ""}</span> : null}</div>
              ) },
              { key: "a", label: "", align: "end", render: (d) => (d.status !== "delivered" ? <Btn label="Retry" small id={`nt-retry-${d.id}`} guard={perm} onClick={() => void retry(d)} /> : null) },
            ]}
          />
        </Panel>
      )}</Async>
      {page.next ? <div className="more"><Btn label="Show more" id="nt-dl-more" onClick={() => setLimit(limit + 200)} /></div> : null}
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

/* ---------- card templates tab: the three built-in cards as the server draws them, then the custom-card editor ---------- */

const PREVIEW_KINDS: Array<[string, string]> = [["gate", "Gate card"], ["question", "Question card"], ["release", "Release card"]];

function CardPreview({ p, kind, title }: { p: Project; kind: string; title: string }) {
  const q = usePreview(p.id, { event: KIND_EVENT[kind] ?? kind, template: kind, fields: { ...ALL_FIELDS } });
  const s = q.data?.sample;
  const target = p.notifications.find((r) => r.template === kind)?.dest[0]?.target;
  return (
    <Panel title={title} id={`nt-card-${kind}`}>
      {s ? (
        <div className="card">
          {target ? <div className="micro">{target}</div> : null}
          <b>{s.head}</b>
          <div className="small muted">{s.project.name} · {s.prio} · {s.clsName}</div>
          <div className="row">{(q.data?.actions ?? []).map((a, i) => <span key={a} className={`chip ${i === 0 && a === "approve" ? "ok" : "info"}`}>{ACTION_LABEL[a] ?? a}</span>)}</div>
        </div>
      ) : <p className="muted small">{q.isError ? "The preview could not be drawn." : "Drawing the preview…"}</p>}
    </Panel>
  );
}

export function CardsTab({ p, nt, perm }: { p: Project; nt: Nt; perm: Decision }) {
  return (
    <div className="stack">
      <div className="cols w3" id="nt-card-previews">{PREVIEW_KINDS.map(([k, t]) => <CardPreview key={k} p={p} kind={k} title={t} />)}</div>
      <TemplatesTab p={p} nt={nt} perm={perm} />
    </div>
  );
}
