/**
 * Security, Authentication tab (prototype section 1 "Sign-in policy" and section 2 "Restore needs two people"): one form with one Save,
 * the way the Blueprint draws it. Each changed setting is sent as its own PATCH /security with the version just read (the server takes one
 * path at a time); the form saves what changed and stops at the first refusal.
 */
import { useRef, useState, type FormEvent } from "react";
import type { SecuritySettings } from "@gantry/domain";
import { useUI } from "../../ui/overlay-context";
import { setSecurity } from "./commands";
import { Btn, Field, Panel, Select, Toggle, focusFirstInvalid, reasonText, type Decision } from "../../ui/primitives";
import { nextVersion, useOutcome, versionOf } from "../govern/data";
import { inCidr, parseCidr } from "./cidr";
import { useSet } from "./More";

const PROVIDERS = ["Okta", "Azure AD", "OpenID Connect", "Google"];
const MFA = [{ value: "off", label: "Off" }, { value: "admins", label: "Admins only" }, { value: "all", label: "Everyone" }];

interface Vals { provider: string; domain: string; enforced: boolean; mfa: string; hours: string; idle: string; ip: string }
const lines = (t: string): string[] => t.split("\n").map((x) => x.trim()).filter(Boolean);

export function PolicyPanels({ perm, sec, thisIp }: { perm: Decision; sec: SecuritySettings; thisIp: string }) {
  const outcome = useOutcome();
  const ui = useUI();
  const set = useSet(sec);
  const form = useRef<HTMLFormElement>(null);
  const base: Vals = { provider: sec.sso.provider, domain: sec.sso.domain, enforced: sec.sso.enforced, mfa: sec.mfa.policy, hours: String(sec.sessionHours), idle: String(sec.idleMin), ip: sec.ipAllow.join("\n") };
  const [d, setD] = useState<Vals | null>(null);
  const [err, setErr] = useState<Partial<Record<keyof Vals, string>>>({});
  const [busy, setBusy] = useState(false);
  const cur = d ?? base;
  const upd = (patch: Partial<Vals>) => setD({ ...cur, ...patch });
  const dirty = JSON.stringify(cur) !== JSON.stringify(base);

  const validate = (): Partial<Record<keyof Vals, string>> => {
    const e: Partial<Record<keyof Vals, string>> = {};
    const dom = cur.domain.trim().toLowerCase();
    if (!dom) e.domain = "Email domain is required.";
    else if (!/^[\w.-]+\.\w+$/.test(dom)) e.domain = "Enter a domain like acme.dev.";
    const h = Number(cur.hours);
    if (cur.hours.trim() === "" || Number.isNaN(h)) e.hours = "Session length (hours) is required.";
    else if (h < 1) e.hours = "Session length (hours) must be at least 1.";
    const m = Number(cur.idle);
    if (cur.idle.trim() === "" || Number.isNaN(m)) e.idle = "Idle timeout (minutes) is required.";
    else if (m < 5) e.idle = "Idle timeout (minutes) must be at least 5.";
    const ips = lines(cur.ip);
    if (ips.some((x) => !parseCidr(x))) e.ip = "Each line must be a CIDR such as 10.0.0.0/8.";
    else if (ips.length && !ips.some((x) => inCidr(thisIp, x))) e.ip = `This list would lock you out: your address ${thisIp} is outside every range.`;
    return e;
  };

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErr(e);
    if (Object.keys(e).length) {
      setTimeout(() => form.current && focusFirstInvalid(form.current), 0);
      return;
    }
    // the prototype validates first, then says why a read-only role cannot save
    if (!perm.allowed) {
      ui.toast(reasonText(perm) || "You do not have permission to change this.", "error");
      return;
    }
    setBusy(true);
    let ver = versionOf(sec);
    const todo: Array<[string, unknown]> = [];
    if (cur.provider !== sec.sso.provider) todo.push(["sso.provider", cur.provider]);
    if (cur.domain.trim().toLowerCase() !== sec.sso.domain) todo.push(["sso.domain", cur.domain.trim().toLowerCase()]);
    if (cur.enforced !== sec.sso.enforced) todo.push(["sso.enforced", cur.enforced]);
    if (cur.mfa !== sec.mfa.policy) todo.push(["mfa.policy", cur.mfa]);
    if (Number(cur.hours) !== sec.sessionHours) todo.push(["sessionHours", Number(cur.hours)]);
    if (Number(cur.idle) !== sec.idleMin) todo.push(["idleMin", Number(cur.idle)]);
    const ips = lines(cur.ip).map((x) => parseCidr(x)!.text);
    if (JSON.stringify(ips) !== JSON.stringify(sec.ipAllow)) todo.push(["ipAllow", ips]);
    let ok = true;
    for (const [path, value] of todo) {
      const r = await setSecurity(path, value, ver !== undefined ? { ifMatch: ver } : undefined);
      if (!r.ok) {
        outcome(r);
        ok = false;
        break;
      }
      if (ver !== undefined) ver = nextVersion(r, ver);
    }
    if (ok) outcome({ ok: true, msg: "Security settings saved", status: 200 });
    setD(null);
    setBusy(false);
  };

  return (
    <>
      <Panel title="Sign-in policy" id="sec-policy">
        <form ref={form} noValidate onSubmit={(e) => void save(e)} id="sec-policy-form">
          <div className="cols">
            <div>
              <Field label="SSO provider" htmlFor="sec-sso-provider"><Select id="sec-sso-provider" options={PROVIDERS.includes(cur.provider) ? PROVIDERS : [cur.provider, ...PROVIDERS]} value={cur.provider} disabled={!perm.allowed} onChange={(v) => upd({ provider: v })} /></Field>
              <Field label={<>Email domain <span className="muted">(required)</span></>} htmlFor="sec-sso-domain" error={err.domain}><input id="sec-sso-domain" aria-required="true" className="input" value={cur.domain} disabled={!perm.allowed} autoComplete="off" onChange={(e) => upd({ domain: e.target.value })} /></Field>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <Toggle id="sec-sso-enforced" checked={cur.enforced} decision={perm} onChange={(v) => upd({ enforced: v })} />
                <label htmlFor="sec-sso-enforced" className="strong" title="Email and password sign-in is refused.">Require SSO for everyone</label>
              </div>
            </div>
            <div>
              <Field label="MFA policy" htmlFor="sec-mfa-policy"><Select id="sec-mfa-policy" title="Recorded only: Gantry does not check it at sign-in, so enforce it in your identity provider." options={MFA} value={cur.mfa} disabled={!perm.allowed} onChange={(v) => upd({ mfa: v })} /></Field>
              <Field label={<>Session length (hours) <span className="muted">(required)</span></>} htmlFor="sec-hours" error={err.hours}><input id="sec-hours" aria-required="true" className="input" type="number" min={1} value={cur.hours} disabled={!perm.allowed} onChange={(e) => upd({ hours: e.target.value })} /></Field>
              <Field label={<>Idle timeout (minutes) <span className="muted">(required)</span></>} htmlFor="sec-idle" error={err.idle}><input id="sec-idle" aria-required="true" className="input" type="number" min={5} value={cur.idle} disabled={!perm.allowed} onChange={(e) => upd({ idle: e.target.value })} /></Field>
            </div>
          </div>
          <Field label="IP allow list" htmlFor="sec-ip" hint="One CIDR per line. Empty means anywhere." error={err.ip}><textarea id="sec-ip" className="input mono" rows={3} value={cur.ip} disabled={!perm.allowed} onChange={(e) => upd({ ip: e.target.value })} /></Field>
          <div className="row">
            <Btn label="Save settings" kind="primary" type="submit" id="sec-save" aria-disabled={!perm.allowed ? "true" : undefined} title={!perm.allowed ? reasonText(perm) : undefined} disabledReason={busy ? "Saving…" : undefined} />
            {dirty ? <Btn label="Discard" kind="ghost" id="sec-discard" onClick={() => { setD(null); setErr({}); }} /> : null}
          </div>
        </form>
      </Panel>
      <Panel title="Restore needs two people" id="sec-restore">
        <div className="toggle-row">
          <label htmlFor="sec-two"><span className="strong">Two approvers to restore the factory after an emergency stop</span><span className="muted small">Two different Factory Admins must approve the restore.</span></label>
          <Toggle id="sec-two" checked={sec.restoreFactoryNeedsTwo} decision={perm} onChange={(v) => void set("restoreFactoryNeedsTwo", v, "Saved")} />
        </div>
      </Panel>
    </>
  );
}
