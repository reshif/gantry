/** The Connected, Catalogue and Custom builder tabs (legacy connectedTab, catalogueTab, customTab). */
import { useState } from "react";
import { INTEGRATION_CATEGORIES, NOTIFY_EVENTS, fmt, type IntegrationInstance } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Empty, Field, FilterBar, LockNote, Panel, SearchBox, Select, type Decision } from "../../ui/primitives";
import { useActors } from "../../ui/actors";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { AUTHS, DirTags, FTYPES, Health, Mark, PAYLOADS, catName, evName, keyOf, scopeText, slug, statusOf, useIntegrationData, usageLine, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

interface Nav { q: string; setQ: (v: string) => void; cat: string; setCat: (v: string) => void; status: string; setStatus: (v: string) => void }

function Filters({ nav, withStatus, count }: { nav: Nav; withStatus: boolean; count?: string }) {
  return (
    <FilterBar label="Filter connections" count={count}>
      <SearchBox id="int-q" label="Search" placeholder="Search by name, type or category" value={nav.q} onChange={nav.setQ} />
      <div className="filters">
        <Field label="Category" htmlFor="int-cat"><Select id="int-cat" options={[{ value: "all", label: "All categories" }, ...INTEGRATION_CATEGORIES.map((c) => ({ value: c.id, label: c.name }))]} value={nav.cat} onChange={nav.setCat} /></Field>
        {withStatus ? <Field label="Status" htmlFor="int-status"><Select id="int-status" options={[{ value: "all", label: "Any status" }, { value: "healthy", label: "Healthy" }, { value: "failing", label: "Failing" }, { value: "disabled", label: "Disabled" }]} value={nav.status} onChange={nav.setStatus} /></Field> : null}
      </div>
    </FilterBar>
  );
}

export function ConnectedTab({ nav, openInstance }: { nav: Nav; openInstance: (id: string) => void }) {
  const d = useIntegrationData();
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const q = nav.q.trim().toLowerCase();
  const matches = (t: TypeRow, extra: string) => (nav.cat === "all" || t.category === nav.cat) && (!q || `${t.name} ${catName(t.category)} ${extra}`.toLowerCase().includes(q));
  const rows = d.insts.filter((i) => matches(d.typeOf(i), i.name) && (nav.status === "all" || statusOf(i) === nav.status));
  const bad = d.insts.filter((i) => statusOf(i) !== "healthy");
  const keyFn: Record<string, (i: IntegrationInstance) => string | number> = {
    name: (i) => i.name.toLowerCase(), category: (i) => catName(d.typeOf(i).category), scope: (i) => (i.projects === "all" ? "" : scopeText(i, d.pname)), status: (i) => statusOf(i), sync: (i) => -i.lastSync,
  };
  const sorted = [...rows].sort((a, b) => { const x = keyFn[sort.key]!(a), y = keyFn[sort.key]!(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  const th = (key: string, label: string, cls = "") => (
    <th scope="col" className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      {keyFn[key] ? <button type="button" className="th-sort" onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })}>{label}</button> : label}
    </th>
  );
  return (
    <div className="form-grid">
      {bad.length ? (
        <div className="callout callout-warn int-attn" role="note">
          <Icon name="alert" />
          <div>
            <strong>{bad.length === 1 ? "1 connection needs attention" : `${bad.length} connections need attention`}</strong>
            {bad.map((i) => <div key={i.id}><button type="button" className="linkish" id={`int-attn-${i.id}`} onClick={() => openInstance(i.id)}>{i.name}</button> is {statusOf(i)}</div>)}
          </div>
        </div>
      ) : null}
      <Panel flush>
      <Filters nav={nav} withStatus count={`${sorted.length} of ${d.insts.length}`} />
      {!sorted.length ? (
        <Empty title={d.insts.length ? "No connection matches" : "Nothing connected"} text={d.insts.length ? "Change the search or filters." : "Add an integration to start."} />
      ) : (
        <div className="dtable-wrap" id="int-table">
          <table className="dtable">
            <caption className="sr-only">Connected integrations</caption>
            <thead>
              <tr>{th("name", "Connection")}{th("category", "Category", "hide-sm")}{th("scope", "Projects")}{th("status", "Status")}<th scope="col">Used by</th>{th("sync", "Last sync", "is-end hide-sm")}</tr>
            </thead>
            <tbody>
              {sorted.map((i) => {
                const t = d.typeOf(i);
                return (
                  <tr key={i.id} data-key={i.id}>
                    <td data-label="Connection">
                      <div className="int-cell-name">
                        <Mark icon={t.icon} small />
                        <div>
                          <button type="button" className="linkish int-name-btn" id={`int-open-${i.id}`} onClick={() => openInstance(i.id)}>{i.name}</button>
                          <div className="small muted">{t.name}{t.custom ? " · custom" : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Category" className="hide-sm">{catName(t.category)}</td>
                    <td data-label="Projects">{scopeText(i, d.pname)}</td>
                    <td data-label="Status"><Health st={statusOf(i)} /></td>
                    <td data-label="Used by"><span className="small">{usageLine(d.usage(i))}</span></td>
                    <td data-label="Last sync" className="is-end hide-sm"><span className="mono small">{fmt.ago(i.lastSync, Date.now())}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </Panel>
    </div>
  );
}

export function CatalogueTab({ nav, openType, onAdd, goBuild }: { nav: Nav; openType: (id: string) => void; onAdd: (id: string) => void; goBuild: () => void }) {
  const d = useIntegrationData();
  const perm = dec(useCan("integration.add"));
  const q = nav.q.trim().toLowerCase();
  const byQ = d.types.filter((t) => !q || `${t.name} ${catName(t.category)}`.toLowerCase().includes(q));
  const list = byQ.filter((t) => nav.cat === "all" || t.category === nav.cat);
  const chips = [{ id: "all", name: "All", n: byQ.length }, ...INTEGRATION_CATEGORIES.map((c) => ({ id: c.id, name: c.name, n: byQ.filter((t) => t.category === c.id).length }))];
  return (
    <div className="form-grid">
      <div className="int-catbar">
        <div className="int-catsearch"><input id="int-q" className="input" type="search" value={nav.q} placeholder="Search by name or category" aria-label="Search the catalogue" onChange={(e) => nav.setQ(e.target.value)} /></div>
        <div className="int-catchips" role="group" aria-label="Category">
          {chips.map((c) => (
            <button type="button" key={c.id} className={`int-catchip${nav.cat === c.id ? " is-on" : ""}`} id={`int-catf-${c.id}`} aria-pressed={nav.cat === c.id ? "true" : "false"} disabled={!c.n && c.id !== nav.cat} onClick={() => nav.setCat(c.id)}>
              {c.name}<span className="int-catn">{c.n}</span>
            </button>
          ))}
        </div>
      </div>
      {list.length ? (
        <div className="int-grid">
          {list.map((t) => {
            const n = d.insts.filter((i) => i.type === t.id).length;
            const off = t.available === false;
            const guard: Decision = off ? { allowed: false, reason: t.unavailableReason ?? "Not yet available." } : perm;
            return (
              <article className={`panel int-tile${t.custom ? " is-custom" : ""}`} aria-label={t.name} key={t.id}>
                <div className="int-tile-head">
                  <Mark icon={t.icon} />
                  <div className="int-tile-name"><div className="int-sub">{catName(t.category)}</div><h3 className="int-name">{t.name}</h3></div>
                </div>
                <div className="int-tags"><DirTags t={t} />{off ? <span className="tag">not yet available</span> : null}{n ? <span className="tag int-n">{n} connected</span> : null}</div>
                <p className="small int-what">{AUTHS.find((a) => a.value === t.auth)?.label ?? t.auth}, {t.fields.length} settings. {t.actions.length ? `Can ${t.actions.slice(0, 3).join(", ").replace(/_/g, " ")}.` : ""}</p>
                <div className="int-tile-actions">
                  <Btn label="Add" small kind="primary" icon="plus" id={`int-cat-add-${t.id}`} guard={guard} onClick={() => onAdd(t.id)} />
                  <Btn label="Details" small id={`int-cat-info-${t.id}`} onClick={() => openType(t.id)} />
                </div>
              </article>
            );
          })}
        </div>
      ) : <Empty id="int-cat-empty" title="No type matches" text="Try another word or category, or build a custom integration." action={<Btn label="Build custom integration" small id="int-cat-build" onClick={goBuild} />} />}
    </div>
  );
}

interface Builder {
  name: string; category: string; auth: string; source: boolean; destination: boolean; targetLabel: string; payload: string; events: string[]; inbound: string; actions: string; template: string;
  fields: Array<{ label: string; key: string; type: string; required: boolean; options: string }>;
}
const newBuilder = (): Builder => ({
  name: "", category: "custom", auth: "hmac", source: false, destination: true, targetLabel: "Target", payload: "json", events: ["kill", "andon", "released"], inbound: "", actions: "post_event", template: "",
  fields: [{ label: "Endpoint URL", key: "url", type: "url", required: true, options: "" }, { label: "Signing secret", key: "secret", type: "secret", required: true, options: "" }],
});
const list = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

function builderDef(b: Builder) {
  const inbound = b.source ? list(b.inbound) : [];
  return {
    name: b.name.trim(), category: b.category, auth: b.auth, payload: b.payload, source: b.source, destination: b.destination, targetLabel: b.destination ? b.targetLabel.trim() || "Target" : "Target", icon: "plug",
    fields: b.fields.map((f) => ({ key: f.key.trim(), label: f.label.trim(), type: f.type, required: !!f.required, ...(f.type === "select" ? { options: list(f.options) } : {}) })),
    events: [...(b.destination ? b.events : []), ...inbound], actions: list(b.actions),
    ...(b.destination && b.template.trim() ? { httpTemplate: { method: "POST", body: b.template, contentType: b.payload === "form" ? "application/x-www-form-urlencoded" : "application/json" } } : {}),
  };
}

function builderError(b: Builder, typeIds: string[]): string | null {
  if (!b.name.trim()) return "Name the integration.";
  if (typeIds.includes(slug(b.name))) return "An integration type with this name exists.";
  if (!b.source && !b.destination) return "Pick whether Gantry sends to it, receives from it, or both.";
  const keys: Record<string, number> = {};
  for (const [i, f] of b.fields.entries()) {
    if (!f.label.trim()) return `Field ${i + 1} needs a label.`;
    if (!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(f.key.trim())) return `Field ${f.label}: the key uses letters and digits and starts with a letter.`;
    if (keys[f.key.trim()]) return `Two fields use the key ${f.key.trim()}.`;
    keys[f.key.trim()] = 1;
    if (f.type === "select" && list(f.options).length < 2) return `Field ${f.label} needs at least two choices.`;
  }
  if (b.destination && !b.fields.some((f) => f.type === "url")) return "Templated HTTP out needs an endpoint: add a URL field.";
  if (b.source && !b.fields.some((f) => f.type === "secret")) return "A signed webhook in needs a signing secret: add a secret field.";
  if (list(b.actions).some((a) => !/^[a-z][a-z0-9_]*$/.test(a))) return "Actions are lowercase words joined by underscores, like post_event.";
  if (b.source && list(b.inbound).some((e) => !/^[a-z][a-z0-9_.]*$/.test(e))) return "Inbound events are lowercase names like ticket.created.";
  if (b.source && !b.inbound.trim()) return "List at least one event it sends to Gantry.";
  if (b.destination && !b.events.length) return "Pick at least one Gantry event it can receive.";
  return null;
}

function samplePayload(def: ReturnType<typeof builderDef>): { out?: string; in?: string } {
  const now = new Date();
  const out: { out?: string; in?: string } = {};
  const all = NOTIFY_EVENTS.map((e) => e.id);
  if (def.destination) {
    const ev = def.events.find((e) => all.includes(e)) ?? "released";
    let body: Record<string, unknown> = { id: `evt_${(now.getTime() % 1e8).toString(36)}`, type: ev, created_at: now.toISOString(), project: "payments", work_order: { id: "WO-2417", title: "Sample work order", repo: "payments-api", class: "feature" }, summary: evName(ev) };
    if (def.payload === "cloudevents") body = { specversion: "1.0", id: body.id, source: "gantry", type: `dev.gantry.${ev}`, time: body.created_at, datacontenttype: "application/json", data: body };
    out.out = def.httpTemplate?.body ?? (def.payload === "form" ? Object.keys(body).filter((k) => typeof body[k] !== "object").map((k) => `${k}=${encodeURIComponent(String(body[k]))}`).join("&") : JSON.stringify(body, null, 2));
  }
  if (def.source) {
    const inEv = def.events.find((e) => !all.includes(e)) ?? "item.created";
    out.in = JSON.stringify({ event: inEv, id: `src-${now.getTime() % 1e5}`, title: "Checkout returns 500 for gift cards", labels: ["gantry", "bug"], repo: "payments-api" }, null, 2);
  }
  return out;
}

export function CustomTab({ onAddInstance, openType }: { onAddInstance: (id: string) => void; openType: (id: string) => void }) {
  const ui = useUI();
  const d = useIntegrationData();
  const actor = useActors();
  const perm = dec(useCan("integration.add"));
  const ro = !perm.allowed;
  const [b, setB] = useState<Builder>(newBuilder);
  const [built, setBuilt] = useState<string | null>(null);
  const upd = (patch: Partial<Builder>) => setB((x) => ({ ...x, ...patch }));
  const setField = (i: number, patch: Partial<Builder["fields"][number]>) => setB((x) => ({ ...x, fields: x.fields.map((f, n) => (n === i ? { ...f, ...patch } : f)) }));
  const err = builderError(b, d.types.map((t) => t.id));
  const def = builderDef(b);
  const custom = d.types.filter((t) => t.custom);
  const sp = samplePayload(def);
  const builtType = built ? d.types.find((t) => t.id === built) : null;
  const cats = INTEGRATION_CATEGORIES.filter((c) => c.id !== "source");
  const save = async () => {
    const r = await ops.addIntegrationType(def);
    if (!r.ok) return ui.toast(r.msg, "error");
    ui.toast(r.msg, "ok");
    setBuilt(String((r as unknown as { type: { id: string } }).type.id));
    setB(newBuilder());
  };
  const rm = async (t: TypeRow) => {
    const r = await ops.removeIntegrationType(t.id);
    ui.toast(r.msg, r.ok ? "ok" : "error");
  };
  return (
    <div className="form-grid">
      {builtType ? (
        <div className="callout callout-ok" role="status" id="int-b-done"><Icon name="check" /><span>{builtType.name} is in the catalogue. </span>
          <Btn label={`Add a ${builtType.name} connection`} small kind="primary" id="int-b-add-inst" guard={perm} onClick={() => { setBuilt(null); onAddInstance(builtType.id); }} /></div>
      ) : null}
      <div className="int-bsplit">
        <Panel title="Custom integration builder" cls="int-builder-panel">
          <div className="form-grid int-builder">
            <LockNote decision={perm} what="Custom integration types" />
            <p className="muted small">A custom type is a signed webhook in and templated HTTP out. It can be a notification destination and a trigger source; it cannot act as source control.</p>
            <div className="form-row">
              <Field label="Name" htmlFor="int-b-name"><input id="int-b-name" className="input" value={b.name} placeholder="Incident board" disabled={ro} onChange={(e) => upd({ name: e.target.value })} /></Field>
              <Field label="Category" htmlFor="int-b-cat"><Select id="int-b-cat" options={cats.map((c) => ({ value: c.id, label: c.name }))} value={b.category} disabled={ro} onChange={(v) => upd({ category: v })} /></Field>
              <Field label="Auth" htmlFor="int-b-auth"><Select id="int-b-auth" options={AUTHS} value={b.auth} disabled={ro} onChange={(v) => upd({ auth: v })} /></Field>
            </div>
            <fieldset className="int-fs">
              <legend className="field-label">Direction</legend>
              <div className="nt-inline int-inline">
                <label className="check" htmlFor="int-b-dst"><input type="checkbox" id="int-b-dst" checked={b.destination} disabled={ro} onChange={(e) => upd({ destination: e.target.checked })} />Gantry sends events to it (notification destination)</label>
                <label className="check" htmlFor="int-b-src"><input type="checkbox" id="int-b-src" checked={b.source} disabled={ro} onChange={(e) => upd({ source: e.target.checked })} />It sends events to Gantry (trigger source)</label>
              </div>
            </fieldset>
            <div className="form-row">
              {b.destination ? <Field label="Target label" htmlFor="int-b-target" hint="What a route picks inside it, shown next to the destination."><input id="int-b-target" className="input" value={b.targetLabel} placeholder="Board, channel, queue" disabled={ro} onChange={(e) => upd({ targetLabel: e.target.value })} /></Field> : null}
              <Field label="Payload format" htmlFor="int-b-payload"><Select id="int-b-payload" options={PAYLOADS} value={b.payload} disabled={ro} onChange={(v) => upd({ payload: v })} /></Field>
            </div>
            <fieldset className="int-fs">
              <legend className="field-label">Config fields</legend>
              <div className="table-scroll">
                <table className="table table-compact int-ftable">
                  <thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Required</th><th>Choices</th><th><span className="sr">Remove</span></th></tr></thead>
                  <tbody>
                    {b.fields.map((f, i) => (
                      <tr key={i}>
                        <td><input id={`int-b-f-label-${i}`} className="input" value={f.label} disabled={ro} aria-label={`Field ${i + 1} label`} onChange={(e) => { const auto = !f.key || f.key === keyOf(f.label); setField(i, { label: e.target.value, ...(auto ? { key: keyOf(e.target.value) } : {}) }); }} /></td>
                        <td><input id={`int-b-f-key-${i}`} className="input mono" value={f.key} disabled={ro} aria-label={`Field ${i + 1} key`} onChange={(e) => setField(i, { key: e.target.value })} /></td>
                        <td><Select id={`int-b-f-type-${i}`} options={FTYPES} value={f.type} disabled={ro} aria-label={`Field ${i + 1} type`} onChange={(v) => setField(i, { type: v })} /></td>
                        <td><input type="checkbox" id={`int-b-f-req-${i}`} checked={f.required} disabled={ro || f.type === "bool"} aria-label={`Field ${i + 1} required`} onChange={(e) => setField(i, { required: e.target.checked })} /></td>
                        <td>{f.type === "select" ? <input id={`int-b-f-opts-${i}`} className="input mono" value={f.options} placeholder="eu, us" disabled={ro} aria-label={`Field ${i + 1} choices`} onChange={(e) => setField(i, { options: e.target.value })} /> : null}</td>
                        <td><Btn small kind="ghost" icon="x" aria={`Remove field ${f.label || i + 1}`} id={`int-b-f-rm-${i}`} guard={ro ? perm : null} onClick={() => setB((x) => ({ ...x, fields: x.fields.filter((_, n) => n !== i) }))} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Btn label="Add field" small icon="plus" id="int-b-f-add" guard={perm} onClick={() => setB((x) => ({ ...x, fields: [...x.fields, { label: "", key: "", type: "text", required: false, options: "" }] }))} />
            </fieldset>
            {b.destination ? (
              <fieldset className="int-fs">
                <legend className="field-label">Gantry events it can receive</legend>
                <div className="check-grid">
                  {NOTIFY_EVENTS.map((e) => (
                    <label className="check" htmlFor={`int-b-ev-${e.id.replace(/\./g, "-")}`} key={e.id}>
                      <input type="checkbox" id={`int-b-ev-${e.id.replace(/\./g, "-")}`} checked={b.events.includes(e.id)} disabled={ro} onChange={(ev) => upd({ events: ev.target.checked ? [...b.events, e.id] : b.events.filter((x) => x !== e.id) })} />
                      <span className="small">{e.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {b.destination ? <Field label="Request body template" htmlFor="int-b-template" hint="Optional. Placeholders: {{head}}, {{body}}, {{woId}}, {{title}}, {{repo}}, {{link}}, {{event}}, {{project}}. Empty sends Gantry's event envelope."><textarea id="int-b-template" className="input mono" rows={3} value={b.template} placeholder='{"text":"{{head}} {{link}}"}' disabled={ro} onChange={(e) => upd({ template: e.target.value })} /></Field> : null}
            {b.source ? <Field label="Events it sends to Gantry" htmlFor="int-b-in" hint="Comma separated. Triggers on this source fire on these."><input id="int-b-in" className="input mono" value={b.inbound} placeholder="ticket.created, ticket.labeled" disabled={ro} onChange={(e) => upd({ inbound: e.target.value })} /></Field> : null}
            <Field label="Actions it can perform" htmlFor="int-b-actions" hint="Comma separated, lowercase with underscores."><input id="int-b-actions" className="input mono" value={b.actions} placeholder="post_event, resolve" disabled={ro} onChange={(e) => upd({ actions: e.target.value })} /></Field>
            <p className={`small int-b-status${err ? " muted" : ""}`} role="status" id="int-b-err">{ro ? "" : err ? `To add it: ${err.charAt(0).toLowerCase()}${err.slice(1)}` : "Ready to add."}</p>
            <div className="form-actions">
              <Btn label="Reset" id="int-b-reset" guard={ro ? perm : null} onClick={() => setB(newBuilder())} />
              <Btn label="Add to catalogue" kind="primary" icon="plus" id="int-b-save" guard={!perm.allowed ? perm : err ? { allowed: false, reason: err } : null} onClick={() => void save()} />
            </div>
          </div>
        </Panel>
        <Panel title="Preview" cls="int-preview-panel">
          <div className="form-grid">
            <div className="int-typeline"><Mark small /><strong>{def.name || "Unnamed integration"}</strong><span className="muted small">{catName(def.category)}</span><DirTags t={{ custom: true, source: def.source, destination: def.destination }} /></div>
            <div className="nt-sub int-sub">Add form people will fill in</div>
            <div className="int-form-preview" id="int-b-preview">
              <Field label="Connection name" htmlFor="int-bp-name"><input id="int-bp-name" className="input" disabled value={`${def.name || "Custom"} (production)`} readOnly /></Field>
              {def.fields.filter((f) => f.key && f.label).map((f) => (
                <Field key={f.key} label={f.label + (f.required === false ? " (optional)" : "")} htmlFor={`int-bp-${f.key}`}>
                  {f.type === "select" ? <Select id={`int-bp-${f.key}`} options={((f as { options?: string[] }).options ?? []).map((o) => ({ value: o, label: o }))} value="" disabled /> : <input id={`int-bp-${f.key}`} className="input" disabled type={f.type === "secret" ? "password" : "text"} placeholder={f.type === "url" ? "https://" : ""} />}
                </Field>
              ))}
            </div>
            {sp.out ? <div><div className="nt-sub int-sub">Sample payload Gantry sends ({PAYLOADS.find((p) => p.value === def.payload)?.label})</div><pre className="api-pre mono int-pre" tabIndex={0} id="int-b-sample" aria-label="Sample outbound payload">{sp.out}</pre></div> : null}
            {sp.in ? <div><div className="nt-sub int-sub">Sample event it sends to Gantry</div><pre className="api-pre mono int-pre" tabIndex={0} id="int-b-sample-in" aria-label="Sample inbound event">{sp.in}</pre></div> : null}
            <p className="footnote">Instances of this type appear as {[def.destination ? "notification destinations" : null, def.source ? "trigger sources in API & triggers" : null].filter(Boolean).join(" and ")}.</p>
          </div>
        </Panel>
      </div>
      <Panel title={`Custom types (${custom.length})`} flush>
        {!custom.length ? <Empty title="No custom types" text="Build one above." /> : (
          <div className="dtable-wrap" id="int-custom-table">
            <table className="dtable">
              <caption className="sr-only">Custom integration types</caption>
              <thead><tr><th>Type</th><th>Category</th><th>Direction</th><th className="is-end">Fields</th><th className="is-end">Connected</th><th className="hide-sm">Created</th><th /></tr></thead>
              <tbody>
                {custom.map((t) => {
                  const n = d.insts.filter((i) => i.type === t.id).length;
                  return (
                    <tr key={t.id}>
                      <td><button type="button" className="linkish" id={`int-ct-open-${t.id}`} onClick={() => openType(t.id)}>{t.name}</button></td>
                      <td>{catName(t.category)}</td>
                      <td><DirTags t={t} /></td>
                      <td className="is-end mono">{t.fields.length}</td>
                      <td className="is-end mono">{n}</td>
                      <td className="hide-sm">{actor(t.createdBy).name}{t.createdAt ? `, ${fmt.ago(t.createdAt, Date.now())}` : ""}</td>
                      <td className="is-end"><span className="row gap-sm int-ct-ops">
                        <Btn label="Add" small icon="plus" id={`int-ct-add-${t.id}`} guard={perm} onClick={() => onAddInstance(t.id)} />
                        <Btn label="Remove" small kind="ghost" id={`int-ct-rm-${t.id}`} guard={!perm.allowed ? perm : n ? { allowed: false, needs: "", reason: `${n} connection${n > 1 ? "s use" : " uses"} this type. Remove ${n > 1 ? "them" : "it"} first.` } : null} onClick={() => void rm(t)} />
                      </span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
