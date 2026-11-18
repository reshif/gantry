/** The Limits tab (legacy limitsTab): rate limit, burst and idempotency window, webhook signing, and the organisation's switch for triggers (off in a new install, spec 15.3). */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Field, LockNote, Panel, Toggle } from "../../ui/primitives";
import { useUI } from "../../ui/overlay-context";
import { dec, type ApiData } from "./kit";
import type { ApiConfig } from "@gantry/domain";

export function LimitsForm({ cfg }: { cfg: ApiConfig }) {
  const ui = useUI();
  const perm = dec(useCan("integration.edit"));
  const ro = !perm.allowed;
  const [d, setD] = useState({ rateLimit: String(cfg.rateLimit), burst: String(cfg.burst), idempotencyHours: String(cfg.idempotencyHours) });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const num = (id: string, key: "rateLimit" | "burst" | "idempotencyHours", label: string) => (
    <Field label={`${label} (required)`} htmlFor={id} error={errs[key]}>
      <input id={id} className="input mono" type="number" min="1" value={d[key]} disabled={ro} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </Field>
  );
  const save = async () => {
    const lab = { rateLimit: "Requests per minute", burst: "Burst", idempotencyHours: "Idempotency window (hours)" } as const;
    const e: Record<string, string> = {};
    for (const k of ["rateLimit", "burst", "idempotencyHours"] as const) {
      if (d[k].trim() === "") e[k] = `${lab[k]} is required.`;
      else if (!(Number(d[k]) >= 1)) e[k] = `${lab[k]} must be at least 1.`;
    }
    const rl = Number(d.rateLimit), b = Number(d.burst), ih = Number(d.idempotencyHours);
    if (!Object.keys(e).length && (!(rl <= 6000) || !(b <= 1000) || !(ih <= 168) || [rl, b, ih].some((n) => Math.floor(n) !== n))) e.rateLimit = "Use whole numbers: rate 1 to 6000, burst 1 to 1000, window 1 to 168 hours.";
    setErrs(e);
    if (Object.keys(e).length) return;
    const r = await ops.setApiConfig({ rateLimit: rl, burst: b, idempotencyHours: ih, webhookSigning: cfg.webhookSigning, triggersEnabled: cfg.triggersEnabled === true }, cfg.version !== undefined ? { ifMatch: cfg.version } : undefined);
    ui.toast(r.ok ? "Limits saved" : r.msg, r.ok ? "ok" : "error");
  };
  return (
    <Panel title="Rate limits" id="api-limits-panel">
      <form className="stack api-lim" noValidate onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
        <LockNote decision={perm} what="API settings" />
        {num("api-lim-rate", "rateLimit", "Requests per minute")}
        {num("api-lim-burst", "burst", "Burst")}
        {num("api-lim-idem", "idempotencyHours", "Idempotency window (hours)")}
        <dl className="kv">
          <dt>Webhook signing</dt><dd>{cfg.webhookSigning}</dd>
          <dt>Triggers</dt>
          <dd>
            <label className="row small" htmlFor="api-tr-master-sw">
              <span>All triggers on for the organisation</span>
              <Toggle id="api-tr-master-sw" label="Triggers enabled for the organisation" checked={cfg.triggersEnabled === true} decision={perm}
                onChange={(v) => void ops.setApiConfig({ rateLimit: cfg.rateLimit, burst: cfg.burst, idempotencyHours: cfg.idempotencyHours, webhookSigning: cfg.webhookSigning, triggersEnabled: v }, cfg.version !== undefined ? { ifMatch: cfg.version } : undefined).then((r) => ui.toast(r.ok ? (v ? "Triggers on" : "Triggers off") : r.msg, r.ok ? "ok" : "error"))} />
            </label>
          </dd>
        </dl>
        <div><Btn label="Save limits" kind="primary" type="submit" id="api-lim-save" guard={perm} /></div>
      </form>
    </Panel>
  );
}

export function LimitsTab({ d }: { d: ApiData }) {
  if (!d.cfg) return null;
  // Re-keyed on the saved version so the form follows a save (or another person's change).
  return <LimitsForm key={d.cfg.version ?? 0} cfg={d.cfg} />;
}
