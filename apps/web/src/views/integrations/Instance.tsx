/** The connection drawer, its edit / disable / remove dialogs, and the type drawer (legacy instanceDrawer, editDialog, toggleDialog, removeDialog, typeDrawer). */
import { useState } from "react";
import { DAY, fmt, type IntegrationInstance } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { useChatLinks, useMe } from "../../api/queries";
import { Btn, Field, LockNote, type Decision } from "../../ui/primitives";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { useActors } from "../../ui/actors";
import { AUTHS, DirTags, Health, Mark, PAYLOADS, ScopePicker, catName, configOf, control, emptyVals, evName, scopeText, secretsOf, statusOf, useInstanceDeliveries, useIntegrationData, usageCount, validate, type FormVals, type TypeRow, type Usage } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

export function ImpactList({ u, inst, pname }: { u: Usage; inst: IntegrationInstance; pname: (id: string) => string }) {
  const rows: Array<{ key: string; icon: string; text: React.ReactNode; chip?: React.ReactNode }> = [];
  for (const x of u.routes) rows.push({ key: `r-${x.project.id}-${x.route.id}`, icon: "bell", text: <>{x.project.name} route {x.route.id}: {evName(x.route.event)} → <span className="mono">{x.target}</span></>, chip: <span className="chip chip-block">pinned</span> });
  for (const x of u.implicit) rows.push({ key: `i-${x.project.id}-${x.route.id}`, icon: "bell", text: <>{x.project.name} route {x.route.id}: {evName(x.route.event)} → <span className="mono">{x.target}</span></>, chip: <span className="chip">resolves here</span> });
  for (const x of u.overrides) rows.push({ key: `o-${x.repo.id}-${x.o.id}`, icon: "branch", text: <>{x.repo.name} override {x.o.id || ""}: {evName(x.o.event)}</> });
  for (const x of u.triggers) {
    const t = x as unknown as { id: string; name: string; project: string; enabled: boolean };
    rows.push({ key: `t-${t.id}`, icon: "api", text: <>Trigger {t.id} {t.name} on {pname(t.project)}</>, chip: t.enabled ? <span className="chip chip-block">on</span> : <span className="chip">off</span> });
  }
  for (const x of u.repos) rows.push({ key: `p-${x.id}`, icon: "branch", text: <span className="mono">{x.name}</span>, chip: <span className="muted small">source for onboarding PRs and merges</span> });
  if (!rows.length) return <p className="muted small">Nothing depends on {inst.name}.</p>;
  return (
    <ul className="plain-list int-impact">
      {rows.map((r) => (
        <li key={r.key}><Icon name={r.icon} /><span>{r.text}</span>{r.chip}</li>
      ))}
    </ul>
  );
}

export function EditIntegration({ inst, close }: { inst: IntegrationInstance; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const d = useIntegrationData();
  const t = d.typeOf(inst);
  const [name, setName] = useState(inst.name);
  const [vals, setVals] = useState<FormVals>(() => ({ ...emptyVals(t), config: { ...emptyVals(t).config, ...(inst.config as FormVals["config"]) }, secrets: {} }));
  const [projects, setProjects] = useState<"all" | string[]>(inst.projects);
  const [err, setErr] = useState("");
  const save = async () => {
    let e = !name.trim() ? "Name this connection." : validate(t, vals, false);
    if (!e && projects !== "all" && !projects.length) e = "Pick at least one project, or all projects.";
    if (!e && projects !== "all") {
      const u = d.usage(inst);
      const lost = u.routes.filter((x) => !projects.includes(x.project.id)).map((x) => `${x.project.name} ${x.route.id}`);
      if (lost.length) e = `Still used outside the new scope: ${lost.join(", ")}.`;
    }
    if (e) return setErr(e);
    const secrets = secretsOf(vals);
    const r = await ops.updateIntegration(inst.id, { name: name.trim(), config: configOf(t, vals), projects, ...(Object.keys(secrets).length ? { secrets } : {}) }, inst.version !== undefined ? { ifMatch: inst.version } : undefined);
    if (!r.ok) return setErr(r.msg);
    ui.toast(r.msg, "ok");
    close();
  };
  return (
    <Dialog title={`Edit ${inst.name}`} kicker={t.name} wide onClose={close} actions={[{ label: "Cancel" }, { label: "Save changes", kind: "primary", submit: true, id: "int-ed-go", guard: perm, onClick: () => void save() }]} body={(
      <div className="form-grid int-add">
        <LockNote decision={perm} what={inst.name} />
        <Field label="Connection name" htmlFor="int-ed-name"><input id="int-ed-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {t.fields.map((f) =>
          f.type === "bool" ? <div className="field" key={f.key}>{control("int-ed-", f, vals, setVals, !perm.allowed)}</div> : (
            <Field key={f.key} label={f.label + (f.required === false ? " (optional)" : "")} htmlFor={`int-ed-${f.key}`} hint={f.type === "secret" ? `Leave empty to keep ${inst.secretMask || "the current secret"}. Enter a new value to rotate it.` : f.type === "url" ? "Must start with https://." : undefined}>
              {control("int-ed-", f, vals, setVals, !perm.allowed)}
            </Field>
          ),
        )}
        <ScopePicker prefix="int-ed-scope-" projects={d.projects} live={d.live} value={projects} onChange={setProjects} ro={!perm.allowed} />
        <div className="form-err" role="alert" id="int-ed-err">{err}</div>
      </div>
    )} />
  );
}

export function ToggleIntegration({ inst, close }: { inst: IntegrationInstance; close: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const d = useIntegrationData();
  const u = d.usage(inst);
  const [err, setErr] = useState("");
  return (
    <Dialog title={`Disconnect ${inst.name}?`} kicker={d.typeOf(inst).name} onClose={close} actions={[{ label: "Cancel" }, { label: "Disconnect", kind: "danger", id: "int-dis-go", guard: perm, onClick: async () => {
      const r = await ops.updateIntegration(inst.id, { connected: false }, inst.version !== undefined ? { ifMatch: inst.version } : undefined);
      if (!r.ok) return setErr(r.msg);
      ui.toast(`${inst.name} disconnected.`, "ok");
      close();
    } }]} body={(
      <div className="form-grid">
        <p>Stations that use it will fail until it is reconnected. Settings are kept, so reconnecting restores everything.</p>
        <div className="callout callout-block"><Icon name="alert" /><span>Deliveries to it fail and show in the delivery log; triggers from it stop firing; repos that use it as their source cannot open or merge PRs. Kill and restore notices still go out.</span></div>
        <h3 className="sub-h">Depends on it</h3>
        <ImpactList u={u} inst={inst} pname={d.pname} />
        <div className="form-err" role="alert">{err}</div>
      </div>
    )} />
  );
}

export function RemoveIntegration({ inst, close, closeDrawer }: { inst: IntegrationInstance; close: () => void; closeDrawer: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const d = useIntegrationData();
  const u = d.usage(inst);
  const on = u.triggers.filter((x) => (x as unknown as { enabled: boolean }).enabled);
  const reasons = [u.routes.length ? `${u.routes.length} ${u.routes.length > 1 ? "routes send" : "route sends"} to it. Change them in Notifications` : "", on.length ? `${on.length} trigger${on.length > 1 ? "s use" : " uses"} it. Turn ${on.length > 1 ? "them" : "it"} off first` : ""].filter(Boolean);
  const block = reasons.length ? { allowed: false, reason: `${reasons.join("; ")}.`, needs: "" } : null;
  const alt = u.implicit.length ? d.insts.find((x) => x.type === inst.type && x.id !== inst.id) : null;
  return (
    <Dialog title={`Remove ${inst.name}?`} kicker={d.typeOf(inst).name} onClose={close} actions={[{ label: "Cancel" }, { label: `Remove ${inst.name}`, kind: "danger", id: "int-rm-go", guard: block ?? perm, onClick: async () => {
      const r = await ops.removeIntegration(inst.id);
      ui.toast(r.msg, r.ok ? "ok" : "error");
      if (r.ok) { close(); closeDrawer(); }
    } }]} body={(
      <div className="form-grid">
        <p>Removes the connection and its stored secret. This cannot be undone; adding it again needs the secret.</p>
        {block ? <div className="callout callout-block" id="int-rm-blocked"><Icon name="lock" /><span>{block.reason}</span></div> : null}
        {u.implicit.length ? <div className="callout callout-warn"><Icon name="alert" /><span>{u.implicit.length} route{u.implicit.length > 1 ? "s" : ""} pick it by type today. After removal they {alt ? `use ${alt.name}.` : "fail until you pick another destination."}</span></div> : null}
        <h3 className="sub-h">Depends on it</h3>
        <ImpactList u={u} inst={inst} pname={d.pname} />
        <div className="form-actions int-impact-links">
          {u.routes.length || u.implicit.length ? <a href="#notifications" className="linkish" id="int-rm-to-routes">Open Notifications</a> : null}
          {u.triggers.length ? <a href="#api" className="linkish" id="int-rm-to-triggers">Open API &amp; triggers</a> : null}
        </div>
      </div>
    )} />
  );
}

/** Link my chat account (spec 12.3): ask for a one-time code, then send it from the chat app. */
function LinkAccount({ inst }: { inst: IntegrationInstance }) {
  const ui = useUI();
  const links = (useChatLinks().data ?? []).filter((l) => l.channel === "slack");
  const [code, setCode] = useState<{ code: string; command: string; expiresAt: number } | null>(null);
  const request = async () => {
    const r = await ops.requestChatLink("slack", inst.id);
    if (!r.ok) return ui.toast(r.msg, "error");
    const x = r as unknown as { code: string; command: string; expiresAt: number };
    setCode({ code: x.code, command: x.command, expiresAt: x.expiresAt });
  };
  return (
    <>
      <h3 className="sub-h">Your Slack account</h3>
      {links.length ? (
        <ul className="plain-list" id="int-d-links">
          {links.map((l) => (
            <li key={l.id}><Icon name="check" /><span>Linked as <span className="mono">{l.externalId}</span>{l.verifiedAt ? `, ${fmt.ago(l.verifiedAt, Date.now())}` : ""}</span>
              <Btn label="Unlink" small kind="ghost" id={`int-d-unlink-${l.id}`} onClick={async () => { const r = await ops.removeChatLink(l.id); ui.toast(r.msg, r.ok ? "ok" : "error"); }} /></li>
          ))}
        </ul>
      ) : <p className="muted small">Not linked. A click in Slack counts only when your Slack account is linked to you here.</p>}
      <div className="form-actions"><Btn label={links.length ? "Link again" : "Link my Slack account"} small icon="link" id="int-d-link" onClick={() => void request()} /></div>
      {code ? (
        <div className="callout callout-ok" role="status" id="int-d-linkcode"><Icon name="check" />
          <span>In Slack, send <span className="mono">{code.command}</span> within 10 minutes. The code works once.</span></div>
      ) : null}
    </>
  );
}

export function InstanceDrawer({ id, close, onEdit, onToggle, onRemove }: { id: string; close: () => void; onEdit: (i: IntegrationInstance) => void; onToggle: (i: IntegrationInstance) => void; onRemove: (i: IntegrationInstance) => void }) {
  const ui = useUI();
  const d = useIntegrationData();
  const perm = dec(useCan("integration.edit"));
  const actor = useActors();
  const me = useMe();
  const inst = d.insts.find((i) => i.id === id);
  const dl = useInstanceDeliveries(id);
  if (!inst) return null;
  const t = d.typeOf(inst);
  const st = statusOf(inst);
  const u = d.usage(inst);
  const day = dl.filter((x) => x.at > Date.now() - DAY);
  const failed = day.filter((x) => x.status === "failed").length;
  const secretF = t.fields.find((f) => f.type === "secret");
  const test = async () => {
    const r = await ops.testIntegrationInstance(inst.id);
    const out = (r as unknown as { test?: { ok: boolean } }).test;
    ui.toast(r.msg, r.ok && (out?.ok ?? true) ? "ok" : "error");
  };
  return (
    <div className="drawer-inner int-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker">{t.name} · {catName(t.category)}</div>
          <div className="drawer-id"><Mark icon={t.icon} small /><Health st={st} /></div>
          <h2 className="drawer-title">{inst.name}</h2>
        </div>
        <button type="button" className="icon-btn drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        <LockNote decision={perm} what={inst.name} />
        <div className="int-drawer-actions">
          <Btn label="Test connection" small icon="refresh" id="int-d-test" guard={perm} onClick={() => void test()} />
          <Btn label="Edit" small icon="dots" id="int-d-edit" guard={perm} onClick={() => onEdit(inst)} />
          <Btn label={inst.connected ? "Disable" : "Enable"} small kind={inst.connected ? "ghost" : "primary"} icon="power" id="int-d-toggle" guard={perm} onClick={() => onToggle(inst)} />
          <Btn label="Remove" small kind="danger" icon="x" id="int-d-remove" guard={perm} onClick={() => onRemove(inst)} />
        </div>
        {inst.lastTest ? (
          <div className={`callout ${inst.lastTest.ok ? "callout-ok" : "callout-warn"}`} role="status" id="int-d-lasttest">
            <Icon name={inst.lastTest.ok ? "check" : "alert"} />
            <span>Last test {fmt.ago(inst.lastTest.at, Date.now())} by {actor(inst.lastTest.by).name}: {inst.lastTest.ok ? "answered." : `failed${inst.lastTest.lines?.length ? ` (${inst.lastTest.lines.find((l) => /refus|fail|answered|could|did not|missing/i.test(l)) ?? inst.lastTest.lines[0]})` : "."}`}</span>
          </div>
        ) : null}
        {!inst.connected ? <div className="callout callout-warn" id="int-d-off"><Icon name="power" /><span>This connection is switched off. Nothing is sent through it until you enable it.</span></div> : null}
        <dl className="int-kv int-kv-drawer">
          {t.fields.map((f) => {
            // Only the first secret has a mask on record; the others are sealed with it and never shown.
            const firstSecret = t.fields.find((x) => x.type === "secret")?.key === f.key;
            const v = f.type === "secret" ? (firstSecret ? inst.secretMask || "not set" : inst.secretMask ? "set, sealed" : "not set") : f.type === "bool" ? (inst.config[f.key] ? "yes" : "no") : inst.config[f.key];
            return (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd className={f.type === "text" ? undefined : "mono"}>{v == null || v === "" ? <span className="muted">not set</span> : String(v)}</dd>
              </div>
            );
          })}
          {inst.targetId ? <div><dt>Endpoint id</dt><dd className="mono">{inst.targetId}</dd></div> : null}
          <div><dt>Projects</dt><dd>{inst.projects === "all" ? "All projects" : inst.projects.map(d.pname).join(", ")}</dd></div>
          <div><dt>Last sync</dt><dd>{fmt.ago(inst.lastSync, Date.now())}</dd></div>
          <div><dt>Added</dt><dd>{actor(inst.createdBy).name}, {fmt.ago(inst.createdAt, Date.now())}</dd></div>
          <div><dt>Last 24h</dt><dd className={`mono${failed ? " neg" : ""}`}>{day.length} sent{failed ? `, ${failed} failed` : ""}</dd></div>
        </dl>
        {secretF ? null : <p className="muted small">This type stores no secret.</p>}
        {inst.type === "slack" && me ? <LinkAccount inst={inst} /> : null}
        <h3 className="sub-h">What it does</h3>
        <div className="int-caps">
          <div><div className="nt-sub int-sub">Events</div>{t.events.length ? <ul className="int-chips">{t.events.map((e) => <li className="int-chip mono" key={e}>{e}</li>)}</ul> : <p className="muted small">Receives every event a route sends it.</p>}</div>
          <div><div className="nt-sub int-sub">Actions</div>{t.actions.length ? <ul className="int-chips">{t.actions.map((a) => <li className="int-chip mono" key={a}>{a}</li>)}</ul> : <p className="muted small">None declared.</p>}</div>
        </div>
        {t.manifest ? (
          <>
            <div className="nt-sub int-sub">Connector</div>
            <p className="small muted" id="int-d-manifest">Version {t.manifest.version}. Delivery key: {t.manifest.delivery.idempotencyKey}. Retries: {t.manifest.delivery.retryable}. Permanent: {t.manifest.delivery.permanent}.</p>
          </>
        ) : null}
        <h3 className="sub-h">Depends on it ({usageCount(u)})</h3>
        <ImpactList u={u} inst={inst} pname={d.pname} />
        <h3 className="sub-h">Recent deliveries</h3>
        {dl.length ? (
          <div className="table-scroll">
            <table className="table table-compact">
              <thead><tr><th>Time (IST)</th><th>Project</th><th>Event</th><th>Target</th><th>Status</th></tr></thead>
              <tbody>
                {dl.slice(0, 8).map((x) => (
                  <tr key={x.id}>
                    <td className="mono">{fmt.ist(x.at)}</td>
                    <td>{d.projects.find((p) => p.id === x.project)?.key ?? x.project}</td>
                    <td>{evName(x.event)}</td>
                    <td className="mono">{x.target}</td>
                    <td><span className={`outcome o-${x.status === "failed" ? "failed" : "ok"}`}>{x.status === "failed" ? "✕ failed" : x.status === "pending" ? "… pending" : "✓ delivered"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted small">{t.destination ? "Nothing sent yet." : "Source integrations send events to Gantry; nothing is delivered to them."}</p>}
      </div>
    </div>
  );
}

export function TypeDrawer({ id, close, onAdd, onRemove, onOpen }: { id: string; close: () => void; onAdd: (id: string) => void; onRemove: (t: TypeRow) => void; onOpen: (id: string) => void }) {
  const d = useIntegrationData();
  const add = dec(useCan("integration.add"));
  const t = d.types.find((x) => x.id === id);
  if (!t) return null;
  const mine = d.insts.filter((i) => i.type === t.id);
  const available = t.available !== false;
  const addGuard: Decision = !available ? { allowed: false, reason: t.unavailableReason ?? "Not yet available." } : add;
  const rmGuard: Decision = !add.allowed ? add : mine.length ? { allowed: false, needs: "", reason: `${mine.length} connection${mine.length > 1 ? "s use" : " uses"} this type. Remove ${mine.length > 1 ? "them" : "it"} first.` } : add;
  const auth = AUTHS.find((a) => a.value === t.auth)?.label ?? t.auth;
  const payload = PAYLOADS.find((p) => p.value === t.payload)?.label ?? t.payload;
  return (
    <div className="drawer-inner int-drawer">
      <div className="drawer-head">
        <div>
          <div className="kicker">{catName(t.category)}{t.custom ? " · custom type" : " · built in"}</div>
          <div className="drawer-id"><Mark icon={t.icon} small /><DirTags t={t} /></div>
          <h2 className="drawer-title">{t.name}</h2>
        </div>
        <button type="button" className="icon-btn drawer-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </div>
      <div className="drawer-scroll">
        {!available ? <div className="callout callout-warn" id="int-t-unavailable"><Icon name="alert" /><span>{t.unavailableReason}</span></div> : null}
        <div className="int-drawer-actions">
          <Btn label={`Add ${t.name}`} small kind="primary" icon="plus" id="int-t-add" guard={addGuard} onClick={() => { close(); onAdd(t.id); }} />
          {t.custom ? <Btn label="Remove type" small kind="ghost" icon="x" id="int-t-remove" guard={rmGuard} onClick={() => onRemove(t)} /> : null}
        </div>
        <dl className="int-kv int-kv-drawer">
          {([["Auth", auth], ["Payload", payload], ["Target", t.destination ? t.targetLabel || "Target" : "not a destination"], ["Created", t.custom ? `${t.createdBy ?? ""}, ${t.createdAt ? fmt.ago(t.createdAt, Date.now()) : ""}` : "built in"], ...(t.manifest ? ([["Version", t.manifest.version], ["Capabilities", t.manifest.capabilities.join(", ") || "none"]] as const) : [])] as ReadonlyArray<readonly [string, string]>).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
        <h3 className="sub-h">Settings form</h3>
        <div className="int-form-preview">
          {t.fields.map((f) => (f.type === "bool" ? <div className="field" key={f.key}>{control(`int-tp-${t.id}-`, f, { config: {}, secrets: {} }, () => undefined, true)}</div> : <Field key={f.key} label={f.label + (f.required === false ? " (optional)" : "")} htmlFor={`int-tp-${t.id}-${f.key}`}>{control(`int-tp-${t.id}-`, f, { config: {}, secrets: {} }, () => undefined, true)}</Field>))}
        </div>
        <div className="int-caps">
          <div><div className="nt-sub int-sub">Events</div>{t.events.length ? <ul className="int-chips">{t.events.map((e) => <li className="int-chip mono" key={e}>{e}</li>)}</ul> : <p className="muted small">Any.</p>}</div>
          <div><div className="nt-sub int-sub">Actions</div>{t.actions.length ? <ul className="int-chips">{t.actions.map((a) => <li className="int-chip mono" key={a}>{a}</li>)}</ul> : <p className="muted small">None declared.</p>}</div>
        </div>
        <h3 className="sub-h">Connected ({mine.length})</h3>
        {mine.length ? (
          <ul className="plain-list int-uses">
            {mine.map((i) => (
              <li key={i.id}><button type="button" className="linkish" id={`int-t-open-${i.id}`} onClick={() => onOpen(i.id)}>{i.name}</button><span className="muted small">{scopeText(i, d.pname)}</span><Health st={statusOf(i)} /></li>
            ))}
          </ul>
        ) : <p className="muted small">None yet.</p>}
      </div>
    </div>
  );
}

export { navigate };
