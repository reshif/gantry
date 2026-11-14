/** The Limits tab (legacy limitsTab): rate limit, burst and idempotency window, webhook signing, and the organisation's switch for triggers (off in a new install, spec 15.3). */
import { useState } from "react";
import { ops } from "../../api/ops";
import { useCan } from "../../api/can";
import { Btn, Field, LockNote, Panel, Select, Toggle } from "../../ui/primitives";
import { useOutcome } from "../govern/data";
import { dec, type ApiData } from "./kit";
import type { ApiConfig } from "@gantry/domain";

export function LimitsForm({ cfg }: { cfg: ApiConfig }) {
  const out = useOutcome();
  const perm = dec(useCan("integration.edit"));
  const ro = !perm.allowed;
  const [d, setD] = useState({ rateLimit: String(cfg.rateLimit), burst: String(cfg.burst), idempotencyHours: String(cfg.idempotencyHours), webhookSigning: cfg.webhookSigning, triggersEnabled: cfg.triggersEnabled === true });
  const num = (id: string, key: "rateLimit" | "burst" | "idempotencyHours", label: string, hint: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <input id={id} className="input mono" type="number" min="1" value={d[key]} disabled={ro} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </Field>
  );
  const save = async () => {
    const rl = Number(d.rateLimit), b = Number(d.burst), ih = Number(d.idempotencyHours);
    if (!(rl >= 1 && rl <= 6000) || !(b >= 0 && b <= 1000) || !(ih >= 1 && ih <= 168) || [rl, b, ih].some((n) => Math.floor(n) !== n)) {
      out({ ok: false, msg: "Use whole numbers: rate 1 to 6000, burst 0 to 1000, window 1 to 168 hours.", status: 422 });
      return;
    }
    await ops.setApiConfig({ rateLimit: rl, burst: b, idempotencyHours: ih, webhookSigning: d.webhookSigning, triggersEnabled: d.triggersEnabled }, cfg.version !== undefined ? { ifMatch: cfg.version } : undefined).then((r) => out(r));
  };
  return (
    <Panel title="Rate limits and idempotency">
      <div className="form-grid api-lim">
        <LockNote decision={perm} what="API settings" />
        <div className="form-row">
          {num("api-lim-rate", "rateLimit", "Requests per minute per key", "Over the limit returns 429 with Retry-After.")}
          {num("api-lim-burst", "burst", "Burst", "Extra requests allowed in a spike.")}
          {num("api-lim-idem", "idempotencyHours", "Idempotency window (hours)", "Same Idempotency-Key in this window returns the original work order.")}
        </div>
        <Field label="Webhook signing" htmlFor="api-lim-sign" hint="Outbound webhook deliveries are signed with the connection's secret; this is the scheme the worker implements.">
          <Select id="api-lim-sign" options={[{ value: "HMAC-SHA256", label: "HMAC-SHA256" }]} value={d.webhookSigning} onChange={(v) => setD({ ...d, webhookSigning: v })} disabled={ro} />
        </Field>
        <label className="toggle-row api-triggers-switch" htmlFor="api-lim-triggers">
          <span><strong>Triggers</strong><span className="muted small"> Master switch for every trigger in the organisation. Off in a new install; each trigger also has its own switch.</span></span>
          <Toggle id="api-lim-triggers" checked={d.triggersEnabled} onChange={(v) => setD({ ...d, triggersEnabled: v })} decision={ro ? perm : null} label="Triggers enabled" />
        </label>
        <div className="form-actions"><Btn label="Save settings" kind="primary" id="api-lim-save" guard={perm} onClick={() => void save()} /></div>
      </div>
    </Panel>
  );
}

export function LimitsTab({ d }: { d: ApiData }) {
  if (!d.cfg) return null;
  // Re-keyed on the saved version so the form follows a save (or another person's change).
  return <LimitsForm key={d.cfg.version ?? 0} cfg={d.cfg} />;
}
