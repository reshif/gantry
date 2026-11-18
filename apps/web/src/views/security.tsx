/**
 * Security (spec 8.9, 14.1), in the Control Room prototype's layout: Sign-in, Sessions and Network and restore, then the two
 * working tabs the prototype has no room for (History, Emergency stop). Against GET/PATCH /security, /sessions and /signins.
 * Not ported, on purpose: the simulated SSO test sign-in and the idle-warning demo (nothing in the product is simulated).
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import type { SecuritySettings, Session, SignIn } from "@gantry/domain";
import { ops } from "../api/ops";
import { useCan } from "../api/can";
import { useMe, usePeople, useSecurity, useSessions, useSignins } from "../api/queries";
import { Btn, Field, LockNote, Segmented, Select, Tabs, Toggle, Who, type Decision } from "../ui/primitives";
import { Card, CrIcon, Page } from "../ui/cr";
import { DataTable } from "../ui/DataTable";
import { Modal } from "../ui/Modal";
import { Async } from "../ui/async";
import { Icon } from "../ui/Icon";
import { useUI } from "../ui/overlay-context";
import { useQueryState } from "../lib/queryState";
import { ExplainDenial } from "./console/ExplainDenial";
import { lockd, nextVersion, useOutcome, versionOf } from "./govern/data";
import { inCidr, parseCidr } from "./security/cidr";
import { StopTab } from "./security/Stop";

const PROVIDERS = ["Okta", "Microsoft Entra ID", "Google Workspace", "OneLogin"];
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
export const SEC_TABS = ["signin", "sessions", "network", "history", "stop"] as const;
const QS = ["tab", "show", "hist", "method"] as const;

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
  const qs = useQueryState(QS);
  const tab = (SEC_TABS as readonly string[]).includes(qs.values.tab) ? qs.values.tab : "signin";
  const setTab = (t: string) => qs.set({ tab: t === "signin" ? null : t });
  if (!me) return null;
  const head = { eyebrow: "Govern", title: "Security", sub: "Sign-in, sessions and network rules for the whole factory." };
  // without the settings the page is its header and the shared loading, not-visible or failed state, never a blank page
  if (!sec) return <Page {...head} cls="view-security"><Async query={secQ} what="security settings" id="sec">{() => null}</Async></Page>;
  const active = sessions.filter((x) => !x.revoked).length;
  const thisIp = me.session.ip;

  return (
    <Page {...head} cls="view-security">
      {!perm.allowed ? <div className="sec-lock"><LockNote decision={perm} what="Security settings" /><ExplainDenial id="sec-explain" action="security.manage" /></div> : null}
      <Tabs idPrefix="sec-tab" active={tab} onChange={setTab} items={[{ id: "signin", label: "Sign-in" }, { id: "sessions", label: "Sessions", count: active }, { id: "network", label: "Network and restore" }, { id: "history", label: "History", count: signins.length }, { id: "stop", label: "Emergency stop" }]} />
      <div id="sec-tab-panel" role="tabpanel">
        {tab === "network" ? (
          <div className="stack">
            <IpPanel perm={perm} sec={sec} thisIp={thisIp} sessions={sessions} />
            <RestorePanel perm={perm} sec={sec} />
            <div className="grid g2">
              <DomainsPanel perm={perm} sec={sec} mine={me.person.email.split("@")[1] ?? null} />
              <ResearchPanel perm={perm} sec={sec} />
            </div>
            <ChatCapPanel perm={perm} sec={sec} />
          </div>
        ) : tab === "stop" ? (
          <StopTab sec={sec} onSignIn={() => setTab("signin")} />
        ) : tab === "sessions" ? (
          <Async query={sessionsQ} what="sessions" id="sec-sessions">{() => <SessionsTab perm={perm} sessions={sessions} currentId={me.session.id} viewerId={me.person.id} />}</Async>
        ) : tab === "history" ? (
          <Async query={signinsQ} what="sign-in history" id="sec-history">{() => <HistoryTab signins={signins} />}</Async>
        ) : (
          <div className="grid g2">
            <SsoPanel perm={perm} sec={sec} />
            <MfaPanel perm={perm} sec={sec} />
          </div>
        )}
      </div>
    </Page>
  );
}

/* ---------- sign-in tab ---------- */

function SsoPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const ui = useUI();
  return (
    <Card title="Single sign-on" id="sec-sso" acts={<Btn label={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><CrIcon name="edit" />Edit</span>} aria="Edit single sign-on" small id="sec-sso-edit" guard={perm.allowed ? null : perm} onClick={() => ui.open((close) => <SsoDialog sec={sec} close={close} />)} />}>
      <dl className="kv">
        <dt>Provider</dt><dd id="sec-sso-provider">{sec.sso.provider}</dd>
        <dt>Domain</dt><dd><span className="mono" id="sec-sso-domain">{sec.sso.domain}</span></dd>
        <dt>Enforced</dt>
        <dd><Toggle id="sec-sso-enforced" label="Enforce SSO" checked={sec.sso.enforced} decision={perm} onChange={(v) => void set("sso.enforced", v, `${v ? "Enabled" : "Disabled"} Enforce SSO`)} /></dd>
        <dt>Entity</dt><dd><span className="mono ell" id="sec-sso-entity">{sec.sso.entity}</span></dd>
        <dt>GitHub sign-in</dt>
        <dd><Toggle id="sec-gh" label="Allow GitHub sign-in" checked={sec.githubLogin} decision={perm} onChange={(v) => void set("githubLogin", v, `${v ? "Enabled" : "Disabled"} GitHub sign-in`)} /></dd>
      </dl>
    </Card>
  );
}

/** Editing the provider, domain and metadata URL: they are read-only facts on the card, changed here and saved together. */
function SsoDialog({ sec, close }: { sec: SecuritySettings; close: () => void }) {
  const outcome = useOutcome();
  const [cur, setCur] = useState({ provider: sec.sso.provider, domain: sec.sso.domain, entity: sec.sso.entity });
  const [err, setErr] = useState("");
  const dirty = cur.provider !== sec.sso.provider || cur.domain !== sec.sso.domain || cur.entity !== sec.sso.entity;
  const save = async () => {
    if (!DOMAIN_RE.test(cur.domain.trim().toLowerCase())) return setErr("Enter a domain such as acme.dev.");
    if (!/^https:\/\/\S+$/.test(cur.entity.trim())) return setErr("The metadata URL must start with https://.");
    setErr("");
    let ver = versionOf(sec);
    for (const k of ["provider", "domain", "entity"] as const) {
      if (cur[k].trim() !== sec.sso[k]) {
        const r = await ops.setSecurity(`sso.${k}`, cur[k].trim(), ver !== undefined ? { ifMatch: ver } : undefined);
        // each save bumps the version; the next one must carry the new one
        if (r.ok && ver !== undefined) ver = nextVersion(r, ver);
        if (!r.ok) {
          outcome(r);
          return;
        }
      }
    }
    outcome({ ok: true, msg: "SSO settings saved.", status: 200 });
    close();
  };
  return (
    <Modal title="Single sign-on" sub="Recorded for the organisation. The identity provider itself is configured where Gantry's OIDC client is registered." dirty={dirty} onClose={close} onSubmit={(e) => { e.preventDefault(); void save(); }}
      footer={(rc) => <><Btn label="Cancel" onClick={rc} /><Btn label="Save SSO settings" kind="primary" type="submit" id="sec-sso-save" guard={dirty ? null : lockd("Nothing changed yet.")} /></>}>
      <div className="stack">
        <Field label="Identity provider" htmlFor="sec-sso-provider-in"><Select id="sec-sso-provider-in" options={PROVIDERS} value={cur.provider} onChange={(v) => setCur({ ...cur, provider: v })} /></Field>
        <Field label="SSO domain" htmlFor="sec-sso-domain-in"><input id="sec-sso-domain-in" className="input mono" value={cur.domain} autoComplete="off" onChange={(e) => setCur({ ...cur, domain: e.target.value })} /></Field>
        <Field label="Entity (SAML metadata URL)" htmlFor="sec-sso-entity-in"><input id="sec-sso-entity-in" className="input mono" value={cur.entity} autoComplete="off" onChange={(e) => setCur({ ...cur, entity: e.target.value })} /></Field>
        <div className="form-err" role="alert">{err}</div>
      </div>
    </Modal>
  );
}

const REQUIRED_FOR: Array<[string, string]> = [["all", "Everyone"], ["admins", "Admins and approvers"], ["off", "No one"]];

function MfaPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const people = usePeople().data ?? [];
  const methods: Array<[string, string]> = [["totp", "Authenticator app (TOTP)"], ["webauthn", "Security key or passkey (WebAuthn)"], ["sms", "SMS code"]];
  const enrolled = people.filter((p) => p.mfa).length;
  const saved = "Security setting saved";
  const num = (key: "sessionHours" | "idleMin", min: number, max: number) => (e: React.FocusEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n >= min && n <= max && n !== sec[key]) void set(key, n, saved);
  };
  return (
    <Card title="Multi-factor" id="sec-mfa">
      <div className="stack">
        <Field label="Required for" htmlFor="sec-mfa-policy">
          <Select id="sec-mfa-policy" value={sec.mfa.policy} disabled={!perm.allowed} options={REQUIRED_FOR.map(([value, label]) => ({ value, label }))} onChange={(v) => void set("mfa.policy", v, saved)} />
        </Field>
        <Field label="Session length (hours)" htmlFor="sec-hours">
          <input id="sec-hours" className="input" type="number" min={1} max={720} key={`h${sec.sessionHours}`} defaultValue={sec.sessionHours} disabled={!perm.allowed} onBlur={num("sessionHours", 1, 720)} />
        </Field>
        <Field label="Idle timeout (minutes)" htmlFor="sec-idle">
          <input id="sec-idle" className="input" type="number" min={1} max={1440} key={`i${sec.idleMin}`} defaultValue={sec.idleMin} disabled={!perm.allowed} onBlur={num("idleMin", 1, 1440)} />
        </Field>
        <p className="small dim" role="note" id="sec-mfa-notice"><strong>Not enforced yet.</strong> These choices are recorded but sign-in does not check them: Gantry does not require a second factor itself. Use your identity provider to enforce MFA until this is wired in.</p>
        <div className="field">
          <div className="field-label">Allowed methods</div>
          <div className="stack" style={{ gap: 6 }}>
            {methods.map((m) => {
              const on = sec.mfa.methods.includes(m[0]);
              const last = on && sec.mfa.methods.length === 1;
              return (
                <div key={m[0]} className="row spread" title={last ? "Keep at least one method." : undefined}>
                  <span>{m[1]}</span>
                  <Toggle id={`sec-mfa-m-${m[0]}`} label={m[1]} checked={on} decision={!perm.allowed ? perm : last ? lockd("Keep at least one method.") : null} onChange={(v) => void set("mfa.methods", v ? [...sec.mfa.methods, m[0]] : sec.mfa.methods.filter((x) => x !== m[0]), `${m[1]}${v ? " allowed." : " no longer allowed."}`)} />
                </div>
              );
            })}
          </div>
          <div className="field-hint hint">SMS is weaker than an app or a key. At least one method stays on. {`${enrolled} of ${people.length} people enrolled.`}</div>
        </div>
      </div>
    </Card>
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
    <Card title="Allowed email domains">
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
    </Card>
  );
}

/** The prototype's "Add IP range" dialog: one CIDR field, the prototype's error text, Cancel and Add. */
function AddRangeDialog({ sec, close }: { sec: SecuritySettings; close: () => void }) {
  const set = useSet(sec);
  const ui = useUI();
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    const p = parseCidr(val);
    if (!p || !val.includes("/")) return setErr("Use CIDR, e.g. 198.51.100.0/24");
    if (sec.ipAllow.includes(p.text)) return setErr(`${p.text} is already on the list.`);
    const r = await set("ipAllow", [...sec.ipAllow, p.text], "Added");
    if (r.ok) close();
    else ui.toast(r.msg, "error");
  };
  return (
    <Modal title="Add IP range" dirty={!!val} onClose={close} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={(rc) => <><Btn label="Cancel" onClick={rc} /><Btn label="Add" kind="primary" type="submit" id="sec-ip-add-ok" /></>}>
      <Field label="CIDR" htmlFor="sec-ip-new" error={err || undefined}>
        <input id="sec-ip-new" className="input mono" placeholder="198.51.100.0/24" value={val} autoComplete="off" onChange={(e) => setVal(e.target.value)} />
      </Field>
    </Modal>
  );
}

function IpPanel({ perm, sec, thisIp, sessions }: { perm: Decision; sec: SecuritySettings; thisIp: string; sessions: Session[] }) {
  const set = useSet(sec);
  const ui = useUI();
  const covered = sec.ipAllow.filter((c) => inCidr(thisIp, c));
  const remove = (c: string) =>
    ui.dialog({
      title: `Remove ${c}?`, sub: "People connecting from this range will be refused.", body: null,
      actions: [{ label: "Cancel" }, { label: "Remove", kind: "danger", id: "sec-ip-rm-ok", onClick: (close) => { close(); void set("ipAllow", sec.ipAllow.filter((x) => x !== c), "Removed"); } }],
    });
  return (
    <Card title="IP allow list" id="sec-ip" flush hint={<span id="sec-here" className={covered.length ? "" : "bad"}>{"This browser connects from "}<span className="mono">{thisIp}</span>{covered.length ? `, inside ${covered.join(", ")}.` : sec.ipAllow.length ? ", outside every range." : ". With an empty list every address is allowed."}</span>}
      acts={<Btn label="Add range" kind="primary" small icon="plus" id="sec-ip-add" guard={perm.allowed ? null : perm} onClick={() => ui.open((close) => <AddRangeDialog sec={sec} close={close} />)} />}>
      <div className="list">
        {sec.ipAllow.map((c) => {
          const lockout = covered.length === 1 && covered[0] === c;
          const g = !perm.allowed ? perm : lockout ? lockd(`This is the only range covering your address ${thisIp}; removing it would lock you out.`) : null;
          const n = sessions.filter((x) => !x.revoked && inCidr(x.ip, c)).length;
          return (
            <div className="li" key={c}>
              <span className="mono" style={{ flex: 1 }}>{c}</span>
              <span className="dim small">{`${n} active`}</span>
              <Btn label="Remove" small kind="ghost danger" id={`sec-ip-rm-${c.replace(/\W/g, "_")}`} guard={g} onClick={() => remove(c)} />
            </div>
          );
        })}
        {!sec.ipAllow.length ? <div className="li dim">An empty list allows every address.</div> : null}
      </div>
    </Card>
  );
}

/** Restore rules and the fresh sign-in rules that guard a kill and a restore. */
function RestorePanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  return (
    <Card title="Restore rules" id="sec-restore">
      <div className="stack">
        <div className="row spread">
          <div><b>Restoring after emergency stop needs two Factory Admins</b><div className="dim small">Recommended. Prevents a single compromised account from restarting the line.</div></div>
          <Toggle id="sec-two" label="Two admins to restore" checked={sec.restoreFactoryNeedsTwo} decision={perm} onChange={(v) => void set("restoreFactoryNeedsTwo", v, v ? "Factory restore needs two Factory Admins." : "One Factory Admin can restore the factory.")} />
        </div>
        <div className="row spread">
          <div>
            <b>Require a fresh sign-in to kill</b>
            <div className="dim small">A kill is a hard stop, so by default it needs a sign-in within the fresh sign-in window. That stops a stolen or left-open session from halting the factory. Restoring always needs a fresh sign-in, and changing this setting does too. Every change is audited.</div>
          </div>
          <Toggle id="sec-kill-stepup" label="Require a fresh sign-in to kill" checked={sec.killNeedsStepUp !== false} decision={perm} onChange={(v) => void set("killNeedsStepUp", v, v ? "Kill needs a fresh sign-in." : "Kill no longer needs a fresh sign-in. Restore still does.")} />
        </div>
        <Field label="Fresh sign-in window" htmlFor="sec-stepup-window" hint="Kill, restore, policy, role, security and key changes need a sign-in within this time. Changing it needs a fresh sign-in and is audited.">
          <Select id="sec-stepup-window" value={String(sec.stepUpWindowMinutes ?? 15)} disabled={!perm.allowed} options={[5, 10, 15, 30, 60].map((x) => ({ value: String(x), label: `${x} minutes` }))} onChange={(v) => void set("stepUpWindowMinutes", Number(v), `A sign-in now counts as fresh for ${v} minutes.`)} />
        </Field>
      </div>
    </Card>
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
    <Card title="Research allow-list">
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
    </Card>
  );
}

/** The per-person cap on chats (the Console and side threads): a rolling 24 hours of what a person's questions cost. Empty: no cap. */
function ChatCapPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const cur = sec.chatCapUsdPerDay ?? null;
  const [val, setVal] = useState(cur === null ? "" : String(cur));
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!perm.allowed) return;
    const t = val.trim();
    const n = t === "" ? null : Number(t);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100000)) return setErr("Enter dollars per person per day (0 to 100000), or leave it empty for no cap.");
    setErr("");
    await set("chatCapUsdPerDay", n, n === null ? "Chats have no per-person cap." : `Each person may spend ${n.toFixed(2)} USD on chats per 24 hours.`);
  };
  return (
    <Card title="Chat spending per person">
      <div className="form-grid" id="sec-chatcap">
        <p className="small muted">The most one person&apos;s chats (the Console and side threads with agents) may cost over a rolling 24 hours. When it is reached, their next question is refused until earlier answers age out. Work orders keep their own budgets.</p>
        <form className="inline-form" id="sec-chatcap-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input id="sec-chatcap-usd" className="input mono" inputMode="decimal" placeholder="No cap" value={val} disabled={!perm.allowed} aria-label="Dollars per person per 24 hours" onChange={(e) => setVal(e.target.value)} />
          <span className="small muted">USD per person per 24 hours</span>
          <Btn label="Save" type="submit" small id="sec-chatcap-save" guard={perm} />
        </form>
        <div className="form-err" role="alert">{err}</div>
      </div>
    </Card>
  );
}

/* ---------- sessions tab ---------- */

function SessionsTab({ perm, sessions, currentId, viewerId }: { perm: Decision; sessions: Session[]; currentId: string; viewerId: string }) {
  const ui = useUI();
  const outcome = useOutcome();
  const people = usePeople().data;
  const qs = useQueryState(QS);
  const showEnded = qs.values.show === "all";
  const name = (id: string): string => people?.find((p) => p.id === id)?.name ?? id;
  const enrolled = (id: string): boolean | null => { const p = people?.find((x) => x.id === id); return p ? !!p.mfa : null; };
  const rows = sessions.filter((x) => showEnded || !x.revoked);
  const ended = sessions.length - sessions.filter((x) => !x.revoked).length;
  const others = sessions.filter((x) => !x.revoked && x.id !== currentId);
  const revoke = (s: Session) => {
    if (s.id === currentId) {
      ui.dialog({
        title: "Revoke your current session?", kicker: "Sessions", sub: "This signs you out of this browser now.", body: null,
        actions: [{ label: "Cancel" }, { label: "Revoke and sign out", kind: "danger", id: "sec-ses-self-ok", onClick: (close) => { close(); void ops.revokeSession(s.id).then((r) => { if (r.ok) { ui.closeAllDialogs(); ui.toast("Session revoked. You are signed out.", "warn"); } else outcome(r); }); } }],
      });
      return;
    }
    void ops.revokeSession(s.id).then((r) => { if (r.ok) ui.toast("Session ended", "warn"); else outcome(r); });
  };
  return (
    <div className="sec-tabbody">
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 12 }}>
        {ended ? <Btn label={showEnded ? "Hide ended sessions" : `Show ended (${ended})`} small kind="ghost" id="sec-ses-show" onClick={() => qs.set({ show: showEnded ? null : "all" })} /> : null}
        <Btn
          label="Revoke all other sessions" kind="danger" small icon="logout" id="sec-ses-all"
          guard={!perm.allowed ? perm : !others.length ? lockd("No other active sessions.") : null}
          onClick={() => ui.dialog({
            title: `Revoke ${others.length} sessions?`, kicker: "Sessions", sub: "Everyone except you is signed out and must sign in again.", body: null,
            actions: [{ label: "Cancel" }, { label: `Revoke ${others.length}`, kind: "danger", id: "sec-ses-all-ok", onClick: (close) => void (async () => { let n = 0; for (const x of others) if ((await ops.revokeSession(x.id)).ok) n++; close(); ui.toast(`${n} sessions revoked.`, "ok"); })() }],
          })}
        />
      </div>
      <DataTable
        id="sec-sessions-table"
        caption="Sessions"
        rows={rows}
        rowKey={(x) => x.id}
        pageSize={10}
        pager
        sort={{ key: "started", dir: -1 }}
        empty={{ title: "Nothing matches", text: "No sessions fit the current filters.", action: showEnded ? <Btn label="Clear filters" small id="sec-ses-clear" onClick={() => qs.clear()} /> : undefined }}
        columns={[
          { key: "person", label: "Person", sort: (x) => name(x.person), render: (x) => <Who id={x.person} /> },
          { key: "device", label: "Device", sort: true, render: (x) => <span>{x.device}{x.id === currentId ? <span className="chip info" style={{ marginLeft: 6 }}>This session</span> : null}{x.revoked ? <span className="chip idle" style={{ marginLeft: 6 }}>Ended</span> : null}</span> },
          { key: "ip", label: "IP", sort: true, render: (x) => <span className="mono">{x.ip}</span> },
          { key: "started", label: "Started", sort: (x) => x.started, render: (x) => <span className="mono dim" title={fmt.iso(x.started)}>{fmt.ago(x.started, Date.now())}</span> },
          // the API gives enrolment per person, not whether this session passed a second factor
          { key: "mfa", label: "MFA", sort: (x) => (enrolled(x.person) ? 1 : 0), render: (x) => { const e = enrolled(x.person); return e === null ? <span className="dim" title="Not available">–</span> : <span className={`chip ${e ? "ok" : "warn"}`}>{e ? "Yes" : "No"}</span>; } },
          { key: "x", label: "", align: "end", render: (x) => <Btn label="Sign out" small kind="danger" id={`sec-ses-rv-${x.id}`} guard={x.revoked ? lockd("Already ended.") : !perm.allowed && x.person !== viewerId ? perm : null} onClick={() => revoke(x)} /> },
        ]}
      />
    </div>
  );
}

/* ---------- history tab ---------- */

function HistoryTab({ signins }: { signins: SignIn[] }) {
  const qs = useQueryState(QS);
  const hist = qs.values.hist || "all";
  const method = qs.values.method || "all";
  const all = [...signins].sort((a, b) => b.at - a.at);
  const rows = all.filter((x) => (hist === "all" || x.outcome === hist) && (method === "all" || x.method === method));
  const fails24 = all.filter((x) => x.outcome === "failure" && Date.now() - x.at < 86400000).length;
  const methods = [...new Set(all.map((x) => x.method))];
  return (
    <div className="sec-tabbody">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <span className="mono dim" role="status">{`${rows.length} sign-ins · ${fails24} ${fails24 === 1 ? "failure" : "failures"} in the last 24 hours`}</span>
        <span className="row">
          <Segmented name="sec-hist" label="Outcome" value={hist} onChange={(v) => qs.set({ hist: v === "all" ? null : v })} items={[{ id: "all", label: "All" }, { id: "success", label: "Succeeded" }, { id: "failure", label: "Failed" }]} />
          <Select id="sec-hist-method" aria-label="Method" value={method} onChange={(v) => qs.set({ method: v === "all" ? null : v })} options={[{ value: "all", label: "Method: all" }, ...methods.map((m) => ({ value: m, label: m }))]} />
        </span>
      </div>
      <DataTable
        id="sec-hist-table"
        caption="Sign-in history"
        rows={rows}
        rowKey={(x) => `${x.at}-${x.email}-${x.method}-${x.ip}`}
        pageSize={15}
        pager
        empty={{ title: "Nothing matches", text: "No sign-ins fit the current filters.", action: <Btn label="Clear filters" small onClick={() => qs.clear(["tab"])} /> }}
        columns={[
          { key: "at", label: "When", sort: (x) => x.at, render: (x) => <span className="mono dim">{fmt.iso(x.at)}</span> },
          { key: "who", label: "Who", render: (x) => (x.person ? <Who id={x.person} /> : <span className="mono">{x.email}</span>) },
          { key: "method", label: "Method", sort: true, render: (x) => <span className="mono">{x.method}</span> },
          { key: "outcome", label: "Outcome", sort: true, render: (x) => <span className={`chip ${x.outcome === "success" ? "ok" : "bad"}`}>{x.outcome === "success" ? "Succeeded" : "Failed"}</span> },
          { key: "reason", label: "Detail", hideSmall: true, render: (x) => <span className="small">{x.reason || ""}</span> },
          { key: "ip", label: "IP", hideSmall: true, render: (x) => <span className="mono">{x.ip}</span> },
          { key: "device", label: "Device", hideSmall: true, render: (x) => <span className="small">{x.device}</span> },
        ]}
      />
    </div>
  );
}
