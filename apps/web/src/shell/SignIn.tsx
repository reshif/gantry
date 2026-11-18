/**
 * Sign-in screen (legacy auth.js). Sign-in is delegated to the identity provider: the buttons leave
 * the SPA for /auth/login. Demo accounts appear only when the API config says demoAccounts is on.
 */
import { useRef, useState } from "react";
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { Icon } from "../ui/Icon";
import { Btn, Field, focusFirstInvalid, Input } from "../ui/primitives";

/** The Gantry mark, the same one the top bar draws (prototype `G.logo`). */
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 14h14" stroke="currentColor" strokeWidth="2" />
      <path d="M7 14V8h4v6M13 14V6h4v8" fill="none" stroke="var(--accent)" strokeWidth="1.8" />
    </svg>
  );
}

/** The work-email check, with the prototype's messages. The domain comes from the server's config; none named means any address passes. */
export function emailProblem(value: string, domain?: string | null): string {
  const v = value.trim();
  if (!v) return "Email is required.";
  if (!/^[^@\s]+@[^@\s]+$/.test(v)) return "Enter a valid email address.";
  if (domain && !v.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) return `Use an ${domain} address.`;
  return "";
}

/** The dim line under the sign-in form. Every clause comes from the server's config; nothing is stated that the server did not say. */
export function signInFootnote(config: PublicConfig | null): string {
  return [
    config?.allowedDomain ? `Access is limited to the ${config.allowedDomain} domain.` : "",
    config?.mfaRequiredForAdmins ? "MFA is required for admins." : "",
    config?.demoAccounts ? "Development sign-in is on: seeded demo accounts can sign in. Use this only on a local stack." : "",
  ].filter(Boolean).join(" ");
}

/** The guided screen for a Factory Admin whose sign-in had no second factor (the server answered `needs: "mfa_setup"`). */
function MfaSetup() {
  const sp = new URLSearchParams({ mfa: "1" });
  if (window.location.hash.length > 1) sp.set("return_to", `/${window.location.hash}`);
  return (
    <section className="auth-panel box" aria-labelledby="mfa-h" id="auth-mfa">
      <div>
        <h1 className="auth-h" id="mfa-h">Set up two-step sign-in</h1>
        <p className="muted auth-sub">Factory Admins can stop the line and change who may do what, so they sign in with a password and a one-time code.</p>
      </div>
      <ol className="auth-steps">
        <li>Install an authenticator app on your phone (any app that makes six-digit codes).</li>
        <li>Continue below and sign in. Your identity provider shows a QR code the first time: scan it and enter the code it gives you.</li>
        <li>Next time, you enter the code from the app after your password.</li>
      </ol>
      <Btn label="Set up and sign in" kind="primary" id="auth-mfa-go" icon="key" onClick={() => window.location.assign(`/auth/login?${sp.toString()}`)} />
      <p className="muted small">If you have lost your authenticator app, ask another Factory Admin or your identity provider's administrator to reset it.</p>
    </section>
  );
}

export function SignIn({ config, error, needs }: { config: PublicConfig | null; error?: string | null; needs?: string | null }) {
  const demo = !!config?.demoAccounts;
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const go = (method: "sso" | "github", email?: string) => window.location.assign(loginUrl(method, email));
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const emailLink = config?.emailLinkLogin === true;
  const submitEmail = () => {
    const bad = emailProblem(email, config?.allowedDomain);
    setProblem(bad);
    setNotice("");
    if (bad) {
      // the error is rendered on the next paint; focus returns to the field after it
      window.setTimeout(() => { if (form.current) focusFirstInvalid(form.current); }, 0);
      return;
    }
    if (emailLink) go("sso", email.trim());
    else setNotice("Email sign-in links are not available on this server. Use Continue with " + (config?.idpName ?? "SSO") + ".");
  };
  const foot = signInFootnote(config);
  return (
    <div id="auth" className="auth signin">
      <section className="auth-brand art" aria-label="About Gantry">
        <div className="row" style={{ gap: 12, color: "var(--text)" }}>
          <BrandMark />
          <b style={{ fontSize: 18, letterSpacing: ".04em" }}>GANTRY</b>
        </div>
        <div>
          <div className="label">Control room</div>
          <h1 style={{ font: "700 36px/44px var(--font)", maxWidth: "14ch", margin: "8px 0" }}>Agents propose. People approve.</h1>
          <p className="muted" style={{ maxWidth: "40ch" }}>Sign in to run the line: watch work travel the belt, decide at gates and keep every change on the record.</p>
        </div>
        <div className="belt-card" style={{ padding: 0 }} aria-hidden="true">
          <div className="lanes" style={{ padding: 12 }}>
            <div className="lane">
              <span className="tok run" style={{ width: 110 }}><span className="id">WO-1004</span><span className="pr p1">P1</span></span>
              <span className="tok is-gate" style={{ width: 110, marginLeft: 80 }}><span className="id">WO-1021 ⏸</span><span className="pr p2">P2</span></span>
            </div>
          </div>
        </div>
      </section>
      <div className="form">
        {needs === "mfa_setup" ? <MfaSetup /> : (
          <form className="auth-panel box" id="signin" noValidate ref={form} aria-labelledby="auth-h" onSubmit={(e) => { e.preventDefault(); submitEmail(); }}>
            <div>
              <h1 className="auth-h" id="auth-h">Sign in</h1>
              <p className="muted auth-sub">Use your company account.</p>
            </div>
            {error ? (
              <div className="callout callout-block" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
              </div>
            ) : null}
            <Btn label={`Continue with ${config?.idpName ?? "SSO"}`} kind="primary" id="auth-sso-go" onClick={() => go("sso")} />
            <div className="row" style={{ gap: 12 }}><span className="divider" style={{ flex: 1 }} /><span className="dim">or</span><span className="divider" style={{ flex: 1 }} /></div>
            <Field label={<>Work email <span className="dim">(required)</span></>} error={problem || undefined}>
              <Input id="auth-email" type="email" name="email" autoComplete="email" placeholder={config?.allowedDomain ? `you@${config.allowedDomain}` : "you@company.com"} value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Btn label="Email me a sign-in link" id="auth-email-link" onClick={submitEmail} />
            {notice ? <div className="callout" role="status"><Icon name="info" /><span>{notice}</span></div> : null}
            {foot ? <div className="dim" style={{ fontSize: 12 }}>{foot}</div> : null}
            {demo ? (
              <div className="auth-demo">
                <h2 className="auth-demo-h">Demo accounts<span>one click, development only</span></h2>
                <ul className="demo-list">
                  {accounts.map((d) => (
                    <li key={d.id}>
                      <a className="demo-acc" id={`demo-${d.id}`} href={loginUrl("sso", d.email)}>
                        <span className="av av-person av-sm" aria-hidden="true">
                          {d.name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2)}
                        </span>
                        <span className="demo-main">
                          <strong>{d.name}</strong>
                          <span className="muted small">{`${d.role} · ${d.note}`}</span>
                        </span>
                        <Icon name="chevron" />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </form>
        )}
      </div>
    </div>
  );
}
