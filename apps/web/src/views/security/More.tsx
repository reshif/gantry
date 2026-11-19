/**
 * Security, Authentication tab: the controls the Blueprint prototype does not draw but the product needs (KEEP.md): allowed email
 * domains, the research allow-list, chat spending per person, the extra sign-in switches and the emergency stop. They sit below the
 * prototype's two sections as "Network" and "More sign-in controls" and save one setting at a time, as they always did.
 */
import { useState } from "react";
import type { SecuritySettings } from "@gantry/domain";
import { setSecurity } from "./commands";
import { usePeople } from "../../api/queries";
import { Btn, Field, Panel, Select, Toggle, type Decision } from "../../ui/primitives";
import { Icon } from "../../ui/Icon";
import { lockd, useOutcome, versionOf } from "../govern/data";

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** One security setting change: PATCH /security {path, value} with the version we read. */
export function useSet(sec: SecuritySettings | undefined) {
  const outcome = useOutcome();
  const version = versionOf(sec);
  return async (path: string, value: unknown, msg?: string) => outcome(await setSecurity(path, value, version !== undefined ? { ifMatch: version } : undefined), msg);
}

export function DomainsPanel({ perm, sec, mine }: { perm: Decision; sec: SecuritySettings; mine: string | null }) {
  const set = useSet(sec);
  const peopleQ = usePeople();
  const people = peopleQ.data ? peopleQ.data : [];
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

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Hosts station agents may read in governed web research without someone who manages security approving each work order's plan. */
export function ResearchPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const list = sec.researchHosts ? sec.researchHosts : [];
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

/** The per-person cap on chats (the Console and side threads): a rolling 24 hours of what a person's questions cost. Empty: no cap. */
export function ChatCapPanel({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
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
    <Panel title="Chat spending per person">
      <div className="form-grid" id="sec-chatcap">
        <p className="small muted">The most one person&apos;s chats (the Console and side threads with agents) may cost over a rolling 24 hours. When it is reached, their next question is refused until earlier answers age out. Work orders keep their own budgets.</p>
        <form className="inline-form" id="sec-chatcap-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input id="sec-chatcap-usd" className="input mono" inputMode="decimal" placeholder="No cap" value={val} disabled={!perm.allowed} aria-label="Dollars per person per 24 hours" onChange={(e) => setVal(e.target.value)} />
          <span className="small muted">USD per person per 24 hours</span>
          <Btn label="Save" type="submit" small id="sec-chatcap-save" guard={perm} />
        </form>
        <div className="form-err" role="alert">{err}</div>
      </div>
    </Panel>
  );
}


/** GitHub sign-in, the second factors in use (read-only), the fresh sign-in window and the kill step-up: the settings that save on change. */
export function SignInExtras({ perm, sec }: { perm: Decision; sec: SecuritySettings }) {
  const set = useSet(sec);
  const peopleQ = usePeople();
  const people = peopleQ.data ? peopleQ.data : [];
  const enrolled = people.filter((p) => p.mfa === true).length;
  return (
    <Panel title="More sign-in controls">
      <div className="form-grid" id="sec-extras">
        <p className="small muted" id="sec-gh-note">GitHub sign-in is not offered: a login through GitHub carries no second factor in this setup, so Gantry would refuse it. Everyone signs in with single sign-on and a second factor.</p>
        <div className="field" id="sec-mfa-methods">
          <div className="field-label">Second factors accepted</div>
          <ul className="small" style={{ margin: "4px 0" }}>
            <li>Authenticator app (TOTP)</li>
            <li>Security key or passkey (WebAuthn)</li>
            <li>Recovery codes (single use)</li>
          </ul>
          <div className="field-hint" id="sec-mfa-status">{`${sec.mfa.waived ? "Waived on this development stack. " : "Required at every sign-in and every fresh sign-in. "}${peopleQ.data ? `${enrolled} of ${people.length} people are known to hold a second factor (the rest are unknown until their next sign-in, or not enrolled).` : ""} A first authenticator is set up only from a one-time link an administrator issues (People, Reset authenticator).`}</div>
        </div>
        <Field label="Fresh sign-in window" htmlFor="sec-stepup-window" hint="Kill, restore, policy, role, security and key changes need a sign-in within this time. Changing it needs a fresh sign-in and is audited.">
          <Select id="sec-stepup-window" value={String(sec.stepUpWindowMinutes ?? 15)} disabled={!perm.allowed} options={[5, 10, 15, 30, 60].map((x) => ({ value: String(x), label: `${x} minutes` }))} onChange={(v) => void set("stepUpWindowMinutes", Number(v), `A sign-in now counts as fresh for ${v} minutes.`)} />
        </Field>
        <div className="toggle-row">
          <label htmlFor="sec-kill-stepup">
            <span className="strong">Require a fresh sign-in to kill</span>
            <span className="muted small">A kill is a hard stop, so by default it needs a sign-in within the fresh sign-in window. Turn it off if you want a kill to work in an emergency from any signed-in session. Restoring always needs a fresh sign-in (and, for the factory, two Factory Admins). Every change is audited.</span>
          </label>
          <Toggle id="sec-kill-stepup" checked={sec.killNeedsStepUp !== false} decision={perm} onChange={(v) => void set("killNeedsStepUp", v, v ? "Kill needs a fresh sign-in." : "Kill no longer needs a fresh sign-in. Restore still does.")} />
        </div>
      </div>
    </Panel>
  );
}
