/**
 * Security (spec 8.9, 14.1), in the Control Room prototype's layout: exactly three tabs, Sign-in, Sessions and Network and restore.
 * The two working features the prototype has no tab for sit inside them: the sign-in history under the sessions table, and the
 * emergency stop under the restore rules. Against GET/PATCH /security, /sessions and /signins.
 */
import { useState } from "react";
import { fmt } from "@gantry/domain";
import type { SecuritySettings, Session, SignIn } from "@gantry/domain";
import { ops } from "../api/ops";
import { useCan } from "../api/can";
import { useMe, usePeople, useSecurity, useSessions, useSignins } from "../api/queries";
import { Btn, Field, LockNote, Segmented, Select, Tabs, Toggle, Who, type Decision } from "../ui/primitives";
import { Card, Page } from "../ui/cr";
import { DataTable } from "../ui/DataTable";
import { Modal } from "../ui/Modal";
import { Async } from "../ui/async";
import { useUI } from "../ui/overlay-context";
import { useQueryState } from "../lib/queryState";
import { ExplainDenial } from "./console/ExplainDenial";
import { lockd, useOutcome, versionOf } from "./govern/data";
import { inCidr, parseCidr } from "./security/cidr";
import { StopTab } from "./security/Stop";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
export const SEC_TABS = ["signin", "sessions", "network"] as const;
/** Links made before the History and Emergency stop tabs moved into Sessions and Network still land on their content. */
const TAB_ALIAS: Record<string, string> = { history: "sessions", stop: "network" };
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
  const rawTab = TAB_ALIAS[qs.values.tab] ?? qs.values.tab;
  const tab = (SEC_TABS as readonly string[]).includes(rawTab) ? rawTab : "signin";
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
      <Tabs idPrefix="sec-tab" active={tab} onChange={setTab} items={[{ id: "signin", label: "Sign-in" }, { id: "sessions", label: "Sessions", count: active }, { id: "network", label: "Network and restore" }]} />
      <div id="sec-tab-panel" role="tabpanel">
        {tab === "network" ? (
          <div>
            <IpPanel perm={perm} sec={sec} thisIp={thisIp} />
            <div style={{ height: 16 }} />
            <RestorePanel perm={perm} sec={sec} />
            <div style={{ height: 16 }} />
            <Card title="Emergency stop" id="sec-stop-card"><StopTab sec={sec} onSignIn={() => setTab("signin")} /></Card>
          </div>
        ) : tab === "sessions" ? (
          <>
            <Async query={sessionsQ} what="sessions" id="sec-sessions">{() => <SessionsTab perm={perm} sessions={sessions} currentId={me.session.id} viewerId={me.person.id} />}</Async>
            <div style={{ height: 16 }} />
            <Async query={signinsQ} what="sign-in history" id="sec-history">{() => <HistoryTab signins={signins} />}</Async>
          </>
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
  return (
    <Card title="Single sign-on" id="sec-sso">
      <dl className="kv">
        <dt>Provider</dt><dd id="sec-sso-provider">{sec.sso.provider}</dd>
        <dt>Domain</dt><dd><span className="mono" id="sec-sso-domain">{sec.sso.domain}</span></dd>
        <dt>Enforced</dt>
        <dd><Toggle id="sec-sso-enforced" label="Enforce SSO" checked={sec.sso.enforced} decision={perm} onChange={(v) => void set("sso.enforced", v, `${v ? "Enabled" : "Disabled"} Enforce SSO`)} /></dd>
        <dt>Entity</dt><dd><span className="mono ell" id="sec-sso-entity">{sec.sso.entity}</span></dd>
      </dl>
    </Card>
  );
}

const REQUIRED_FOR: Array<[string, string]> = [["all", "Everyone"], ["admins", "Admins and approvers"], ["off", "No one"]];

function MfaPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
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

function IpPanel({ perm, sec, thisIp }: { perm: Decision; sec: SecuritySettings; thisIp: string }) {
  const set = useSet(sec);
  const ui = useUI();
  const covered = sec.ipAllow.filter((c) => inCidr(thisIp, c));
  const remove = (c: string) =>
    ui.dialog({
      title: `Remove ${c}?`, sub: "People connecting from this range will be refused.", body: null,
      actions: [{ label: "Cancel" }, { label: "Remove", kind: "danger", id: "sec-ip-rm-ok", onClick: (close) => { close(); void set("ipAllow", sec.ipAllow.filter((x) => x !== c), "Removed"); } }],
    });
  return (
    <Card title="IP allow list" id="sec-ip" flush
      acts={<Btn label="Add range" kind="primary" small icon="plus" id="sec-ip-add" guard={perm.allowed ? null : perm} onClick={() => ui.open((close) => <AddRangeDialog sec={sec} close={close} />)} />}>
      <div className="list">
        {sec.ipAllow.map((c) => {
          const lockout = covered.length === 1 && covered[0] === c;
          const g = !perm.allowed ? perm : lockout ? lockd(`This is the only range covering your address ${thisIp}; removing it would lock you out.`) : null;
          return (
            <div className="li" key={c}>
              <span className="mono" style={{ flex: 1 }}>{c}</span>
              <Btn label="Remove" small kind="ghost danger" id={`sec-ip-rm-${c.replace(/\W/g, "_")}`} guard={g} onClick={() => remove(c)} />
            </div>
          );
        })}
        {!sec.ipAllow.length ? <div className="li dim">An empty list allows every address.</div> : null}
      </div>
    </Card>
  );
}

/** Restore rules, as the prototype draws them: one row, one switch. */
function RestorePanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  return (
    <Card title="Restore rules" id="sec-restore">
      <div className="stack">
        <div className="row spread">
          <div><b>Restoring after emergency stop needs two Factory Admins</b><div className="dim small">Recommended. Prevents a single compromised account from restarting the line.</div></div>
          <Toggle id="sec-two" label="Two admins to restore" checked={sec.restoreFactoryNeedsTwo} decision={perm} onChange={(v) => void set("restoreFactoryNeedsTwo", v, v ? "Factory restore needs two Factory Admins." : "One Factory Admin can restore the factory.")} />
        </div>
      </div>
    </Card>
  );
}

/* ---------- sessions tab ---------- */

function SessionsTab({ perm, sessions, currentId, viewerId }: { perm: Decision; sessions: Session[]; currentId: string; viewerId: string }) {
  const ui = useUI();
  const outcome = useOutcome();
  const people = usePeople().data;
  const name = (id: string): string => people?.find((p) => p.id === id)?.name ?? id;
  const enrolled = (id: string): boolean | null => { const p = people?.find((x) => x.id === id); return p ? !!p.mfa : null; };
  const rows = sessions.filter((x) => !x.revoked);
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
      <DataTable
        id="sec-sessions-table"
        caption="Sessions"
        rows={rows}
        rowKey={(x) => x.id}
        pageSize={10}
        pager
        sort={{ key: "started", dir: -1 }}
        empty={{ title: "No active sessions", text: "Nobody is signed in." }}
        columns={[
          { key: "person", label: "Person", sort: (x) => name(x.person), render: (x) => <Who id={x.person} /> },
          { key: "device", label: "Device", sort: true, render: (x) => <span>{x.device}{x.id === currentId ? <span className="chip info" style={{ marginLeft: 6 }}>This session</span> : null}</span> },
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
    <Card title="Sign-in history" id="sec-history-card" hint={<span className="mono" role="status">{`${rows.length} sign-ins · ${fails24} ${fails24 === 1 ? "failure" : "failures"} in the last 24 hours`}</span>} flush acts={
        <span className="row">
          <Segmented name="sec-hist" label="Outcome" value={hist} onChange={(v) => qs.set({ hist: v === "all" ? null : v })} items={[{ id: "all", label: "All" }, { id: "success", label: "Succeeded" }, { id: "failure", label: "Failed" }]} />
          <Select id="sec-hist-method" aria-label="Method" value={method} onChange={(v) => qs.set({ method: v === "all" ? null : v })} options={[{ value: "all", label: "Method: all" }, ...methods.map((m) => ({ value: m, label: m }))]} />
        </span>}>
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
    </Card>
  );
}
