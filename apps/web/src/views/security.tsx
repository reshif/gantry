/**
 * Security (spec 8.9, 14.1), laid out as the Blueprint prototype draws it: four stat tiles and three tabs in the URL (`?tab=`):
 * Authentication (Sign-in policy, Restore needs two people), Sessions (Active sessions) and Sign-in log (Recent sign-ins).
 * Network, Emergency stop and the extra sign-in switches the product needs (KEEP.md) sit below the two prototype sections on Authentication.
 * Not ported, on purpose: the simulated SSO test sign-in and the idle-warning demo (nothing in the product is simulated).
 */
import type { SignIn } from "@gantry/domain";
import { useCan } from "../api/can";
import { useMe, useSecurity, useSessions, useSignins } from "../api/queries";
import { navigate } from "../lib/router";
import { Btn, Empty, LockNote, Stat, StatRow, Tabs, ViewHead, type Decision } from "../ui/primitives";
import { Async, failureOf, qState } from "../ui/async";
import { ExplainDenial } from "./console/ExplainDenial";
import { useQueryParam } from "./floor/urlState";
import { PolicyPanels } from "./security/Policy";
import { ChatCapPanel, DomainsPanel, ResearchPanel, SignInExtras } from "./security/More";
import { SessionsTab } from "./security/Sessions";
import { SignInsTab } from "./security/SignIns";
import { StopTab } from "./security/Stop";
import "../styles/views/security.css";

const dec = (d: { allowed: boolean; reason: string; needs?: string | undefined }): Decision => ({ allowed: d.allowed, reason: d.reason, needs: d.needs });
const TABS = ["auth", "sessions", "signins"];

export default function SecurityView() {
  const me = useMe();
  const secQ = useSecurity();
  const sec = secQ.data;
  const sessionsQ = useSessions({ all: true });
  const signinsQ = useSignins({ limit: 200, all: "1" });
  const sessions = sessionsQ.data ? sessionsQ.data : [];
  const signinsRaw = signinsQ.data;
  const signins: SignIn[] = Array.isArray(signinsRaw) ? signinsRaw : signinsRaw?.items ?? [];
  const manage = useCan("security.manage");
  const view = useCan("policy.view");
  const perm = dec(manage);
  const [tabParam, setTab] = useQueryParam("tab");
  const tab = TABS.includes(tabParam ?? "") ? (tabParam as string) : "auth";
  // the stop section is on the Authentication tab, far down the page: this brings it up from wherever the person is
  const jumpToStop = (): void => {
    if (tab !== "auth") setTab(null);
    window.setTimeout(() => document.getElementById("sec-stop-section")?.scrollIntoView?.({ block: "start" }), 0);
  };
  if (!me) return null;
  // not allowed to read it: the prototype's locked sheet with a way home, never a blank page
  if (!sec && ((secQ.isError && failureOf(secQ.error).hidden) || (!manage.pending && !manage.allowed && !view.pending && !view.allowed))) {
    return (
      <div className="view view-security">
        <ViewHead title="Security" kicker="All lines" />
        <Empty id="sec-no-access" icon="lock" title="No access to this sheet" text={<>Your role cannot open Security.<br />{secQ.isError ? failureOf(secQ.error).msg : manage.reason}<br />Ask a factory admin for the policy.view permission.</>} action={<Btn label="Back to Home" id="sec-home" onClick={() => navigate("home")} />} />
      </div>
    );
  }
  // without the settings the page is its header and the shared loading or failed state, never a blank page
  if (!sec) return <div className="view view-security"><ViewHead title="Security" kicker="All lines" /><Async query={secQ} what="security settings" id="sec">{() => null}</Async></div>;
  const active = sessions.filter((x) => !x.revoked).length;
  const fails = signins.filter((x) => x.outcome === "failure").length;
  const thisIp = me.session.ip;

  return (
    <div className="view view-security">
      <ViewHead title="Security" kicker="All lines" sub="Who can sign in, how, and from where." actions={<Btn label="Emergency stop" kind="ghost" icon="halt" id="sec-jump-stop" aria="Jump to Emergency stop" onClick={jumpToStop} />} />
      <StatRow id="sec-stats">
        <Stat label="SSO" value={sec.sso.enforced ? "Enforced" : "Optional"} sub={sec.sso.provider} tone={sec.sso.enforced ? "done" : "wait"} />
        <Stat label="MFA" value={<span title="Recorded only: Gantry does not check it at sign-in.">{sec.mfa.policy}</span>} sub={sec.mfa.methods.length ? sec.mfa.methods.join(", ") : "no methods"} />
        <Stat label="Session" value={`${sec.sessionHours} h`} sub={`${sec.idleMin} min idle`} />
        <Stat label="Failed sign-ins" value={qState(signinsQ, () => String(fails))} sub="recent" tone={fails ? "wait" : undefined} />
      </StatRow>
      {!perm.allowed ? <div className="sec-lock"><LockNote decision={perm} what="Security settings" /><ExplainDenial id="sec-explain" action="security.manage" /></div> : null}
      <Tabs idPrefix="sec-tab" active={tab} onChange={(t) => setTab(t === "auth" ? null : t)} items={[{ id: "auth", label: "Authentication" }, { id: "sessions", label: "Sessions", count: active }, { id: "signins", label: "Sign-in log", count: signins.length }]} />
      <div id="sec-tab-panel" role="tabpanel" aria-labelledby={`sec-tab-${tab}`}>
        {tab === "sessions" ? (
          <Async query={sessionsQ} what="sessions" id="sec-sessions">{() => <SessionsTab perm={perm} sessions={sessions} sec={sec} currentId={me.session.id} viewerId={me.person.id} />}</Async>
        ) : tab === "signins" ? (
          <Async query={signinsQ} what="sign-in log" id="sec-history">{() => <SignInsTab signins={signins} />}</Async>
        ) : (
          <>
            <PolicyPanels perm={perm} sec={sec} thisIp={thisIp} />
            <SignInExtras perm={perm} sec={sec} />
            <DomainsPanel perm={perm} sec={sec} mine={me.person.email.split("@")[1] ?? null} />
            <ResearchPanel perm={perm} sec={sec} />
            <ChatCapPanel perm={perm} sec={sec} />
            <StopTab sec={sec} />
          </>
        )}
      </div>
    </div>
  );
}
