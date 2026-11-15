/**
 * Security (spec 8.9, 14.1). Port of legacy/js/views/security.js against GET/PATCH /security, /sessions and /signins.
 * Not ported, on purpose: the simulated SSO test sign-in and the idle-warning demo (nothing in the product is simulated).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import type { SecuritySettings, Session, SignIn } from "@gantry/domain";
import { ops } from "../api/ops";
import { useCan } from "../api/can";
import { useMe, usePeople, useSecurity, useSessions, useSignins } from "../api/queries";
import { Btn, Field, LockNote, Panel, Segmented, Select, Tabs, Toggle, ViewHead, Who, type Decision } from "../ui/primitives";
import { Async, qState } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { ExplainDenial } from "./console/ExplainDenial";
import { lockd, nextVersion, useOutcome, versionOf } from "./govern/data";
import { inCidr, parseCidr } from "./security/cidr";

const PROVIDERS = ["Okta", "Microsoft Entra ID", "Google Workspace", "OneLogin"];
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });

/** One security setting change: PATCH /security {path, value} with the version we read. */
function useSet(sec: SecuritySettings | undefined) {
  const outcome = useOutcome();
  const version = versionOf(sec);
  return async (path: string, value: unknown, msg?: string) => outcome(await ops.setSecurity(path, value, version !== undefined ? { ifMatch: version } : undefined), msg);
}

export default function SecurityView() {
  const me = useMe();
  const secQ = useSecurity();
  const sec = secQ.data;
  const sessionsQ = useSessions({ all: true });
  const signinsQ = useSignins({ limit: 200, all: "1" });
  const sessions = sessionsQ.data ?? [];
  const signinsRaw = signinsQ.data;
  const signins: SignIn[] = Array.isArray(signinsRaw) ? signinsRaw : signinsRaw?.items ?? [];
  const perm = dec(useCan("security.manage"));
  const [tab, setTab] = useState("signin");
  if (!me) return null;
  // without the settings the page is its header and the shared loading, not-visible or failed state, never a blank page
  if (!sec) return <div className="view view-security"><ViewHead title="Security" /><Async query={secQ} what="security settings" id="sec">{() => null}</Async></div>;
  const active = sessions.filter((x) => !x.revoked).length;
  const fails = signins.filter((x) => x.outcome === "failure" && Date.now() - x.at < 86400000).length;
  const thisIp = me.session.ip;

  return (
    <div className="view view-security">
      <ViewHead
        title="Security"
        sub="How people get in and how long they stay. Every change here is audited under auth."
        meta={[["SSO", sec.sso.enforced ? `${sec.sso.provider}, required` : "optional"], ["MFA", sec.mfa.policy === "all" ? "everyone" : sec.mfa.policy === "admins" ? "admins" : "off"], ["Idle timeout", `${sec.idleMin} min`], ["Active sessions", qState(sessionsQ, () => String(active))], ["Failed sign-ins 24 h", qState(signinsQ, () => String(fails))]]}
      />
      {!perm.allowed ? <div className="sec-lock"><LockNote decision={perm} what="Security settings" /><ExplainDenial id="sec-explain" action="security.manage" /></div> : null}
      <Tabs idPrefix="sec-tab" active={tab} onChange={setTab} items={[{ id: "signin", label: "Sign-in and sessions" }, { id: "network", label: "Domains and network" }, { id: "sessions", label: "Active sessions", count: active }, { id: "history", label: "Sign-in history", count: signins.length }]} />
      <div id="sec-tab-panel" role="tabpanel">
        {tab === "network" ? (
          <>
            <div className="two-col sec-cols"><DomainsPanel perm={perm} sec={sec} mine={me.person.email.split("@")[1] ?? null} /><IpPanel perm={perm} sec={sec} thisIp={thisIp} sessions={sessions} /></div>
            <ResearchPanel perm={perm} sec={sec} />
          </>
        ) : tab === "sessions" ? (
          <Async query={sessionsQ} what="sessions" id="sec-sessions">{() => <Panel><SessionsTab perm={perm} sessions={sessions} sec={sec} currentId={me.session.id} viewerId={me.person.id} /></Panel>}</Async>
        ) : tab === "history" ? (
          <Async query={signinsQ} what="sign-in history" id="sec-history">{() => <Panel><HistoryTab signins={signins} /></Panel>}</Async>
        ) : (
          <div className="two-col sec-cols">
            <div className="sec-stack"><SsoPanel perm={perm} sec={sec} /><MfaPanel perm={perm} sec={sec} /></div>
            <SessionPanel perm={perm} sec={sec} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- sign-in tab ---------- */

function SsoPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const outcome = useOutcome();
  const [d, setD] = useState<{ provider: string; domain: string; entity: string } | null>(null);
  const [err, setErr] = useState("");
  const cur = d ?? { provider: sec.sso.provider, domain: sec.sso.domain, entity: sec.sso.entity };
  const dirty = cur.provider !== sec.sso.provider || cur.domain !== sec.sso.domain || cur.entity !== sec.sso.entity;
  const upd = (patch: Partial<typeof cur>) => setD({ ...cur, ...patch });
  const save = async () => {
    if (!DOMAIN_RE.test(cur.domain.trim().toLowerCase())) return setErr("Enter a domain such as acme.dev.");
    if (!/^https:\/\/\S+$/.test(cur.entity.trim())) return setErr("The metadata URL must start with https://.");
    setErr("");
    let ok = true;
    let ver = versionOf(sec);
    for (const k of ["provider", "domain", "entity"] as const) {
      if (cur[k].trim() !== sec.sso[k]) {
        const r = await ops.setSecurity(`sso.${k}`, cur[k].trim(), ver !== undefined ? { ifMatch: ver } : undefined);
        // each save bumps the version; the next one must carry the new one
        if (r.ok && ver !== undefined) ver = nextVersion(r, ver);
        if (!r.ok) {
          outcome(r);
          ok = false;
          break;
        }
      }
    }
    if (ok) outcome({ ok: true, msg: "SSO settings saved.", status: 200 });
    setD(null);
  };
  return (
    <Panel title="Single sign-on">
      <div className="form-grid">
        <div className="form-row">
          <Field label="Identity provider" htmlFor="sec-sso-provider"><Select id="sec-sso-provider" options={PROVIDERS} value={cur.provider} disabled={!perm.allowed} onChange={(v) => upd({ provider: v })} /></Field>
          <Field label="SSO domain" htmlFor="sec-sso-domain"><input id="sec-sso-domain" className="input mono" value={cur.domain} disabled={!perm.allowed} autoComplete="off" onChange={(e) => upd({ domain: e.target.value })} /></Field>
        </div>
        <Field label="SAML entity / metadata URL" htmlFor="sec-sso-entity" hint="Recorded for the organisation. The identity provider itself is configured where Gantry's OIDC client is registered."><input id="sec-sso-entity" className="input mono" value={cur.entity} disabled={!perm.allowed} autoComplete="off" onChange={(e) => upd({ entity: e.target.value })} /></Field>
        <div className="toggle-grid">
          <div className="toggle-row">
            <label htmlFor="sec-sso-enforced"><span className="strong">Require SSO</span><span className="muted small">Email and password sign-in is refused.</span></label>
            <Toggle id="sec-sso-enforced" checked={sec.sso.enforced} decision={perm} onChange={(v) => void set("sso.enforced", v, v ? "SSO is required." : "SSO is optional now.")} />
          </div>
          <div className="toggle-row">
            <label htmlFor="sec-gh"><span className="strong">Allow GitHub sign-in</span><span className="muted small">People can sign in with their linked GitHub account.</span></label>
            <Toggle id="sec-gh" checked={sec.githubLogin} decision={perm} onChange={(v) => void set("githubLogin", v, v ? "GitHub sign-in allowed." : "GitHub sign-in turned off.")} />
          </div>
        </div>
        <div className="form-err" role="alert">{err}</div>
        <div className="form-actions">
          <Btn label="Save SSO settings" kind="primary" small id="sec-sso-save" guard={!perm.allowed ? perm : !dirty ? lockd("Nothing changed yet.") : null} onClick={() => void save()} />
          {dirty ? <Btn label="Discard" small kind="ghost" id="sec-sso-discard" onClick={() => { setD(null); setErr(""); }} /> : null}
        </div>
      </div>
    </Panel>
  );
}

function MfaPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const people = usePeople().data ?? [];
  const me = useMe();
  const opts: Array<[string, string, string]> = [["off", "Nobody", "MFA is optional for everyone."], ["admins", "Admins", "Factory and Project Admins must use MFA."], ["all", "Everyone", "Every person must use MFA."]];
  const methods: Array<[string, string]> = [["totp", "Authenticator app (TOTP)"], ["webauthn", "Security key or passkey (WebAuthn)"], ["sms", "SMS code"]];
  const enrolled = people.filter((p) => p.mfa).length;
  return (
    <Panel title="Multi-factor authentication">
      <div className="form-grid">
        <div className="radio-cards" role="radiogroup" aria-label="MFA policy">
          {opts.map((o) => (
            <label key={o[0]} className={`radio-card${perm.allowed ? "" : " is-locked"}`} htmlFor={`sec-mfa-${o[0]}`}>
              <input type="radio" name="sec-mfa" id={`sec-mfa-${o[0]}`} value={o[0]} checked={sec.mfa.policy === o[0]} disabled={!perm.allowed} onChange={() => void set("mfa.policy", o[0], `MFA required for: ${o[1].toLowerCase()}.`)} />
              <span className="rc-t">{o[1]}</span>
              <span className="rc-d muted small">{o[2]}</span>
            </label>
          ))}
        </div>
        <div className="field">
          <div className="field-label">Allowed methods</div>
          <div className="check-grid">
            {methods.map((m) => {
              const on = sec.mfa.methods.includes(m[0]);
              const last = on && sec.mfa.methods.length === 1;
              return (
                <label key={m[0]} className="check" htmlFor={`sec-mfa-m-${m[0]}`} title={last ? "Keep at least one method." : undefined}>
                  <input type="checkbox" id={`sec-mfa-m-${m[0]}`} checked={on} disabled={!perm.allowed || last} onChange={(e) => void set("mfa.methods", e.target.checked ? [...sec.mfa.methods, m[0]] : sec.mfa.methods.filter((x) => x !== m[0]), `${m[1]}${e.target.checked ? " allowed." : " no longer allowed."}`)} />
                  {m[1]}
                </label>
              );
            })}
          </div>
          <div className="field-hint">SMS is weaker than an app or a key. At least one method stays on.</div>
        </div>
        <p className="small muted">{`${enrolled} of ${people.length} people enrolled.${me && !me.person.mfa && sec.mfa.policy === "all" ? " You are not enrolled: your next sign-in will ask you to set it up." : ""}`}</p>
      </div>
    </Panel>
  );
}

function SessionPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const hours = [4, 8, 12, 24, 72];
  const idle = [10, 15, 30, 60, 120];
  return (
    <Panel title="Session lifetime and idle timeout">
      <div className="form-grid">
        <div className="form-row">
          <Field label="Session lifetime" htmlFor="sec-hours" hint="After this, people sign in again.">
            <Select id="sec-hours" value={String(sec.sessionHours)} disabled={!perm.allowed} options={hours.map((x) => ({ value: String(x), label: `${x} hours` }))} onChange={(v) => void set("sessionHours", Number(v), `Sessions now last ${v} hours.`)} />
          </Field>
          <Field label="Idle timeout" htmlFor="sec-idle" hint="People who stay idle this long are signed out.">
            <Select id="sec-idle" value={String(sec.idleMin)} disabled={!perm.allowed} options={idle.map((x) => ({ value: String(x), label: `${x} minutes` }))} onChange={(v) => void set("idleMin", Number(v), `Idle timeout set to ${v} minutes.`)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Fresh sign-in window" htmlFor="sec-stepup-window" hint="Kill, restore, policy, role, security and key changes need a sign-in within this time. Changing it needs a fresh sign-in and is audited.">
            <Select id="sec-stepup-window" value={String(sec.stepUpWindowMinutes ?? 15)} disabled={!perm.allowed} options={[5, 10, 15, 30, 60].map((x) => ({ value: String(x), label: `${x} minutes` }))} onChange={(v) => void set("stepUpWindowMinutes", Number(v), `A sign-in now counts as fresh for ${v} minutes.`)} />
          </Field>
        </div>
        <div className="toggle-row">
          <label htmlFor="sec-two"><span className="strong">Factory restore needs two Factory Admins</span><span className="muted small">After a factory kill, two different Factory Admins must approve the restore.</span></label>
          <Toggle id="sec-two" checked={sec.restoreFactoryNeedsTwo} decision={perm} onChange={(v) => void set("restoreFactoryNeedsTwo", v, v ? "Factory restore needs two Factory Admins." : "One Factory Admin can restore the factory.")} />
        </div>
        <div className="toggle-row">
          <label htmlFor="sec-kill-stepup">
            <span className="strong">Require a fresh sign-in to kill</span>
            <span className="muted small">
              A kill is a hard stop, so by default it needs a sign-in within the fresh sign-in window above (15 minutes by default). That stops a stolen or left-open session from halting the factory. Turn it off if you want a kill to work in an emergency from any signed-in session. Restoring always needs a fresh sign-in (and, for the factory, two Factory Admins), and changing this setting needs a fresh sign-in too. Every change is audited.
            </span>
          </label>
          <Toggle id="sec-kill-stepup" checked={sec.killNeedsStepUp !== false} decision={perm} onChange={(v) => void set("killNeedsStepUp", v, v ? "Kill needs a fresh sign-in." : "Kill no longer needs a fresh sign-in. Restore still does.")} />
        </div>
      </div>
    </Panel>
  );
}

/* ---------- network tab ---------- */

function DomainsPanel({ perm, sec, mine }: { perm: Decision; sec: SecuritySettings; mine: string | null }) {
  const set = useSet(sec);
  const people = usePeople().data ?? [];
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!perm.allowed) return;
    const v = val.trim().toLowerCase();
    if (!DOMAIN_RE.test(v)) return setErr("Enter a domain such as contractor.acme.dev.");
    if (sec.domains.includes(v)) return setErr(`${v} is already allowed.`);
    setErr("");
    setVal("");
    await set("domains", [...sec.domains, v], `${v} allowed.`);
  };
  return (
    <Panel title="Allowed email domains">
      <div className="form-grid">
        <p className="small muted">Sign-in and invites are refused for any other domain.</p>
        <ul className="sec-list">
          {sec.domains.map((d) => {
            const users = people.filter((p) => p.email.split("@")[1] === d).length;
            const g = !perm.allowed ? perm : d === mine ? lockd(`You signed in with ${d}; removing it would lock you out.`) : sec.domains.length === 1 ? lockd("Keep at least one allowed domain.") : null;
            return (
              <li key={d}>
                <Icon name="check" /><span className="mono">{d}</span><span className="muted small">{`${users} people`}</span>
                <Btn label="Remove" small kind="ghost" icon="x" id={`sec-dom-rm-${d.replace(/\W/g, "_")}`} guard={g} onClick={() => void set("domains", sec.domains.filter((x) => x !== d), `${d} removed. People on it can no longer sign in.`)} />
              </li>
            );
          })}
        </ul>
        <form className="inline-form" id="sec-dom-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input id="sec-dom-new" className="input mono" placeholder="Domain, e.g. partner.example" value={val} disabled={!perm.allowed} autoComplete="off" aria-label="Domain to allow" onChange={(e) => setVal(e.target.value)} />
          <Btn label="Allow domain" type="submit" small icon="plus" id="sec-dom-add" guard={perm} />
        </form>
        <div className="form-err" role="alert">{err}</div>
      </div>
    </Panel>
  );
}

function IpPanel({ perm, sec, thisIp, sessions }: { perm: Decision; sec: SecuritySettings; thisIp: string; sessions: Session[] }) {
  const set = useSet(sec);
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const covered = sec.ipAllow.filter((c) => inCidr(thisIp, c));
  const submit = async () => {
    if (!perm.allowed) return;
    const p = parseCidr(val);
    if (!p) return setErr("Enter an IPv4 address or CIDR range such as 192.0.2.0/24.");
    if (sec.ipAllow.includes(p.text)) return setErr(`${p.text} is already on the list.`);
    setErr("");
    setVal("");
    await set("ipAllow", [...sec.ipAllow, p.text], `${p.text} added to the allow-list.`);
  };
  return (
    <Panel title="IP allow-list">
      <div className="form-grid">
        <div className={`sec-here ${covered.length ? "is-ok" : "is-bad"}`}>
          <Icon name={covered.length ? "check" : "alert"} />
          <span>{"This browser connects from "}<span className="mono">{thisIp}</span>{covered.length ? `, inside ${covered.join(", ")}.` : sec.ipAllow.length ? ", outside every range." : ". With an empty list every address is allowed."}</span>
        </div>
        <ul className="sec-list">
          {sec.ipAllow.map((c) => {
            const lockout = covered.length === 1 && covered[0] === c;
            const g = !perm.allowed ? perm : lockout ? lockd(`This is the only range covering your address ${thisIp}; removing it would lock you out.`) : null;
            const n = sessions.filter((x) => !x.revoked && inCidr(x.ip, c)).length;
            return (
              <li key={c}>
                <Icon name="shield" /><span className="mono">{c}</span><span className="muted small">{`${n} active sessions`}</span>
                <Btn label="Remove" small kind="ghost" icon="x" id={`sec-ip-rm-${c.replace(/\W/g, "_")}`} guard={g} onClick={() => void set("ipAllow", sec.ipAllow.filter((x) => x !== c), `${c} removed from the allow-list.`)} />
              </li>
            );
          })}
        </ul>
        <form className="inline-form" id="sec-ip-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input id="sec-ip-new" className="input mono" placeholder="CIDR, e.g. 198.51.100.0/24" value={val} disabled={!perm.allowed} autoComplete="off" aria-label="Address range to allow" onChange={(e) => setVal(e.target.value)} />
          <Btn label="Add range" type="submit" small icon="plus" id="sec-ip-add" guard={perm} />
        </form>
        <div className="form-err" role="alert">{err}</div>
        <p className="footnote">Requests and sign-ins from addresses outside these ranges are refused. An empty list allows every address.</p>
      </div>
    </Panel>
  );
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Hosts station agents may read in governed web research without someone who manages security approving each work order's plan. */
function ResearchPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const list = sec.researchHosts ?? [];
  const submit = async () => {
    if (!perm.allowed) return;
    const h = val.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!HOST.test(h)) return setErr("Enter a host such as docs.example.com or *.example.org.");
    if (list.includes(h)) return setErr(`${h} is already on the list.`);
    setErr("");
    setVal("");
    await set("researchHosts", [...list, h].sort(), `${h} added to the research allow-list.`);
  };
  return (
    <Panel title="Research allow-list">
      <div className="form-grid" id="sec-research">
        <p className="small muted">Web hosts that people who approve gates may approve in a work order&apos;s research plan. A host that is not here needs someone who manages security. Agents read only the hosts of an approved plan, through Gantry, and every page is recorded.</p>
        {list.length ? (
          <ul className="sec-list">
            {list.map((h) => (
              <li key={h}>
                <Icon name="page" /><span className="mono">{h}</span><span />
                <Btn label="Remove" small kind="ghost" icon="x" id={`sec-rh-rm-${h.replace(/\W/g, "_")}`} guard={perm.allowed ? null : perm} onClick={() => void set("researchHosts", list.filter((x) => x !== h), `${h} removed from the research allow-list.`)} />
              </li>
            ))}
          </ul>
        ) : <p className="small">No hosts yet: every research plan that wants the web needs someone who manages security.</p>}
        <form className="inline-form" id="sec-rh-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input id="sec-rh-new" className="input mono" placeholder="Host, e.g. docs.nautobot.com" value={val} disabled={!perm.allowed} autoComplete="off" aria-label="Host to allow for research" onChange={(e) => setVal(e.target.value)} />
          <Btn label="Add host" type="submit" small icon="plus" id="sec-rh-add" guard={perm} />
        </form>
        <div className="form-err" role="alert">{err}</div>
      </div>
    </Panel>
  );
}

/* ---------- sessions tab ---------- */

function SessionsTab({ perm, sessions, sec, currentId, viewerId }: { perm: Decision; sessions: Session[]; sec: SecuritySettings; currentId: string; viewerId: string }) {
  const ui = useUI();
  const outcome = useOutcome();
  const [show, setShow] = useState("active");
  const list = [...sessions].sort((a, b) => b.lastSeen - a.lastSeen);
  const maxAge = sec.sessionHours * 3600000;
  const rows = list.filter((x) => show === "all" || !x.revoked);
  const others = list.filter((x) => !x.revoked && x.id !== currentId);
  const revoke = (s: Session) => {
    if (s.id === currentId) {
      ui.dialog({
        title: "Revoke your current session?", kicker: "Sessions", sub: "This signs you out of this browser now.", body: null,
        actions: [{ label: "Cancel" }, { label: "Revoke and sign out", kind: "danger", id: "sec-ses-self-ok", onClick: (close) => { close(); void ops.revokeSession(s.id).then((r) => { if (r.ok) { ui.closeAllDialogs(); ui.toast("Session revoked. You are signed out.", "warn"); } else outcome(r); }); } }],
      });
      return;
    }
    void ops.revokeSession(s.id).then((r) => outcome(r));
  };
  return (
    <div>
      <div className="toolbar sec-toolbar">
        <Segmented name="sec-ses-show" label="Sessions shown" value={show} onChange={setShow} items={[{ id: "active", label: `Active (${list.filter((x) => !x.revoked).length})` }, { id: "all", label: `All (${list.length})` }]} />
        <Btn
          label="Revoke all other sessions" small kind="danger" icon="logout" id="sec-ses-all"
          guard={!perm.allowed ? perm : !others.length ? lockd("No other active sessions.") : null}
          onClick={() => ui.dialog({
            title: `Revoke ${others.length} sessions?`, kicker: "Sessions", sub: "Everyone except you is signed out and must sign in again.", body: null,
            actions: [{ label: "Cancel" }, { label: `Revoke ${others.length}`, kind: "danger", id: "sec-ses-all-ok", onClick: (close) => void (async () => { let n = 0; for (const x of others) if ((await ops.revokeSession(x.id)).ok) n++; close(); ui.toast(`${n} sessions revoked.`, "ok"); })() }],
          })}
        />
      </div>
      <div className="table-scroll" data-keep-scroll="sec-sessions">
        <table className="table table-compact sec-table">
          <thead><tr>{["Person", "Method", "Device", "IP", "Started (IST)", "Last seen", "State", ""].map((x, i) => <th key={i} scope="col">{x}</th>)}</tr></thead>
          <tbody>
            {rows.map((x) => {
              const isCur = x.id === currentId;
              const expired = !x.revoked && Date.now() - x.started > maxAge;
              const own = x.person === viewerId;
              const g = x.revoked ? lockd("Already ended.") : !perm.allowed && !own ? perm : null;
              return (
                <tr key={x.id} className={`${isCur ? "is-selected" : ""}${x.revoked ? " sec-ended" : ""}`}>
                  <td><Who id={x.person} /></td><td className="mono">{x.method}</td><td>{x.device}</td><td className="mono">{x.ip}</td>
                  <td className="mono nowrap">{`${fmt.istDate(x.started)} ${fmt.ist(x.started)}`}</td>
                  <td className="nowrap">{fmt.ago(x.lastSeen, Date.now())}</td>
                  <td>{x.revoked ? <span className="sec-st is-ended"><Icon name="x" />Ended</span> : expired ? <span className="sec-st is-exp"><Icon name="clock" />Past lifetime</span> : <span className="sec-st is-live"><Icon name="check" />{isCur ? "This session" : "Active"}</span>}</td>
                  <td><Btn label={isCur ? "Revoke (signs you out)" : "Revoke"} small kind="ghost" icon="logout" id={`sec-ses-rv-${x.id}`} guard={g} onClick={() => revoke(x)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- history tab ---------- */

function HistoryTab({ signins }: { signins: SignIn[] }) {
  const [hist, setHist] = useState("all");
  const [method, setMethod] = useState("all");
  const [limit, setLimit] = useState(40);
  const all = [...signins].sort((a, b) => b.at - a.at);
  const rows = all.filter((x) => (hist === "all" || x.outcome === hist) && (method === "all" || x.method === method));
  const fails24 = all.filter((x) => x.outcome === "failure" && Date.now() - x.at < 86400000).length;
  const methods = [...new Set(all.map((x) => x.method))];
  return (
    <div>
      <div className="toolbar sec-toolbar">
        <Segmented name="sec-hist" label="Outcome" value={hist} onChange={(v) => { setHist(v); setLimit(40); }} items={[{ id: "all", label: "All" }, { id: "success", label: "Succeeded" }, { id: "failure", label: "Failed" }]} />
        <Field label="Method" htmlFor="sec-hist-method"><Select id="sec-hist-method" value={method} onChange={setMethod} options={[{ value: "all", label: "Any method" }, ...methods.map((m) => ({ value: m, label: m }))]} /></Field>
        <span className="small muted">{`${rows.length} sign-ins · ${fails24} failures in the last 24 h`}</span>
      </div>
      <div className="table-scroll" data-keep-scroll="sec-hist">
        <table className="table table-compact sec-table">
          <thead><tr>{["When (IST)", "Who", "Method", "Outcome", "Detail", "IP", "Device"].map((x) => <th key={x} scope="col">{x}</th>)}</tr></thead>
          <tbody>
            {rows.slice(0, limit).map((x, i) => (
              <tr key={`${x.at}-${i}`} className={x.outcome === "failure" ? "sec-fail" : ""}>
                <td className="mono nowrap">{fmt.iso(x.at)}</td>
                <td>{x.person ? <Who id={x.person} /> : <span className="mono">{x.email}</span>}</td>
                <td className="mono">{x.method}</td>
                <td><span className={`sec-st ${x.outcome === "success" ? "is-live" : "is-fail"}`}><Icon name={x.outcome === "success" ? "check" : "alert"} />{x.outcome === "success" ? "Succeeded" : "Failed"}</span></td>
                <td className="small">{x.reason || ""}</td><td className="mono">{x.ip}</td><td className="small">{x.device}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit ? <div className="more"><Btn label="Show more" small id="sec-hist-more" onClick={() => setLimit(limit + 40)} /></div> : null}
    </div>
  );
}
