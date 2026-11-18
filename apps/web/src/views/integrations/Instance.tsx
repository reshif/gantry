/** The connection drawer and the disconnect confirm, in the prototype's anatomy, and the type drawer of the catalogue. */
import { fmt, type IntegrationInstance } from "@gantry/domain";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Avatar, Btn, Field, type Decision } from "../../ui/primitives";
import { CrIcon } from "../../ui/cr";
import { CrDrawer, Kv, agoShort } from "../connect/kit";
import { Dialog } from "../../ui/Overlay";
import { Icon } from "../../ui/Icon";
import { useUI } from "../../ui/overlay-context";
import { navigate } from "../../lib/router";
import { useActors } from "../../ui/actors";
import { AUTHS, DirTags, Health, Mark, PAYLOADS, catName, control, scopeText, statusOf, useInstanceDeliveries, useIntegrationData, type TypeRow } from "./kit";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** "Disconnect <name>?": the prototype's confirm. A connection that routes or enabled triggers still use is refused, and the button says why. */
export function RemoveIntegration({ inst, close, closeDrawer }: { inst: IntegrationInstance; close: () => void; closeDrawer: () => void }) {
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const d = useIntegrationData();
  const u = d.usage(inst);
  const on = u.triggers.filter((x) => (x as unknown as { enabled: boolean }).enabled);
  const reasons = [u.routes.length ? `${u.routes.length} ${u.routes.length > 1 ? "routes send" : "route sends"} to it. Change them in Notifications` : "", on.length ? `${on.length} trigger${on.length > 1 ? "s use" : " uses"} it. Turn ${on.length > 1 ? "them" : "it"} off first` : ""].filter(Boolean);
  const block = reasons.length ? { allowed: false, reason: `${reasons.join("; ")}.`, needs: "" } : null;
  return (
    <Dialog title={`Disconnect ${inst.name}?`} sub="Projects using it stop receiving events. Secrets are deleted." onClose={close} actions={[{ label: "Cancel" }, { label: "Disconnect", kind: "danger", id: "int-rm-go", guard: block ?? perm, onClick: async () => {
      const r = await ops.removeIntegration(inst.id);
      ui.toast(r.ok ? "Disconnected" : r.msg, r.ok ? "warn" : "error");
      if (r.ok) { close(); closeDrawer(); }
    } }]} body={block ? <div className="callout callout-block" id="int-rm-blocked"><Icon name="lock" /><span>{block.reason}</span></div> : null} />
  );
}

export function InstanceDrawer({ id, close, onRemove }: { id: string; close: () => void; onRemove: (i: IntegrationInstance) => void }) {
  const ui = useUI();
  const d = useIntegrationData();
  const perm = dec(useCan("integration.edit"));
  const actor = useActors();
  const inst = d.insts.find((i) => i.id === id);
  const dl = useInstanceDeliveries(id);
  if (!inst) return null;
  const st = statusOf(inst);
  const recent = dl.slice(0, 5);
  const failed = recent.filter((x) => x.status === "failed");
  const test = async () => {
    ui.toast(`Testing ${inst.name}…`, "info");
    const r = await ops.testIntegrationInstance(inst.id);
    const out = (r as unknown as { test?: { ok: boolean; ms?: number; error?: string } }).test;
    const good = r.ok && (out?.ok ?? true);
    if (good) ui.toast(`${inst.name} is reachable${out?.ms != null ? ` (${out.ms} ms)` : ""}.`, "ok");
    else ui.toast(`${inst.name}: ${out?.error || r.msg || failed[0]?.error || "the test failed"}. Still failing.`, "error");
  };
  const why = st === "failing" ? (failed.length ? `${failed.length > 1 ? `Last ${failed.length} deliveries failed` : "The last delivery failed"}${failed[0]?.error ? `: ${failed[0].error}` : ""}.` : "The last connection test failed.") : st === "degraded" ? "Slow responses: p95 not available." : st === "offline" ? "The service did not answer." : st === "disabled" ? "This connection is switched off." : "";
  return (
    <CrDrawer
      eyebrow={`Integration · ${inst.type}`} title={inst.name} close={close}
      foot={(
        <>
          <Btn label="Test connection" id="int-d-test" guard={perm} onClick={() => void test()} />
          <Btn label="Disconnect…" kind="danger" id="int-d-remove" guard={perm} onClick={() => onRemove(inst)} />
        </>
      )}
    >
      <div className="row"><Health st={st} /></div>
      {why && st !== "healthy" ? <div className={`banner ${st === "failing" ? "bad" : "warn"}`} id="int-d-why"><CrIcon name="warn" /><div className="grow">{why}</div></div> : null}
      <Kv rows={[
        ["Projects", <span key="p">{inst.projects === "all" ? "all" : inst.projects.join(", ")}</span>],
        ["Secret", <span key="s" className="mono">{inst.secretMask || "not set"}</span>],
        ["Connected by", <span key="b" className="row nowrap" style={{ gap: 6 }}><Avatar id={inst.createdBy} /><span className="ell">{actor(inst.createdBy).name}</span></span>],
        ["Last sync", agoShort(inst.lastSync)],
      ]} />
    </CrDrawer>
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
