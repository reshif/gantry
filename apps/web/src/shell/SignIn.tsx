/**
 * Sign-in screen (prototype `signin` route: art panel with the belt card, form box with SSO, work email and a footnote). Sign-in is delegated to the identity provider: the buttons leave
 * the SPA for /auth/login. Demo accounts appear only when the API config says demoAccounts is on.
 */
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { useRef, useState, type FormEvent } from "react";
import { Icon } from "../ui/Icon";
import { Btn, TextInput } from "../ui/primitives";

/** The Control Room mark, the same one the top bar draws, at sign-in size. */
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M5 14h14" stroke="currentColor" strokeWidth="2" /><path d="M7 14V8h4v6M13 14V6h4v8" fill="none" stroke="var(--accent)" strokeWidth="1.8" /></svg>
  );
}

/** The guided screen for a Factory Admin whose sign-in had no second factor (the server answered `needs: "mfa_setup"`). */
function MfaSetup() {
  const sp = new URLSearchParams({ mfa: "1" });
  if (window.location.hash.length > 1) sp.set("return_to", `/${window.location.hash}`);
  return (
    <section className="box" aria-labelledby="mfa-h" id="auth-mfa">
      <div>
        <h2 className="auth-h" id="mfa-h">Set up two-step sign-in</h2>
        <p className="muted">Factory Admins can stop the line and change who may do what, so they sign in with a password and a one-time code.</p>
      </div>
      <ol className="auth-steps">
        <li>Install an authenticator app on your phone (any app that makes six-digit codes).</li>
        <li>Continue below and sign in. Your identity provider shows a QR code the first time: scan it and enter the code it gives you.</li>
        <li>Next time, you enter the code from the app after your password.</li>
      </ol>
      <Btn label="Set up and sign in" kind="primary" id="auth-mfa-go" onClick={() => window.location.assign(`/auth/login?${sp.toString()}`)} />
      <div className="dim auth-foot">If you have lost your authenticator app, ask another Factory Admin or your identity provider's administrator to reset it.</div>
    </section>
  );
}

/** What the e-mail field says about an address, or "" when it is fine (prototype wording). */
export function emailProblem(value: string, domain?: string): string {
  const v = value.trim();
  if (!v) return "Email is required.";
  const dom = domain?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ok = dom ? new RegExp(`^[^@\\s]+@${dom}$`, "i").test(v) : /^[^@\s]+@[^@\s]+$/.test(v);
  return ok ? "" : domain ? `Use an ${domain} address.` : "Enter a valid email address.";
}

/** The footnote under the form: only what the server says about the domain and MFA, never a guess. */
export function signInFootnote(config: PublicConfig | null): string {
  const parts: string[] = [];
  if (config?.allowedDomain) parts.push(`Access is limited to the ${config.allowedDomain} domain.`);
  if (config?.mfaRequiredForAdmins) parts.push("MFA is required for admins.");
  return parts.length ? parts.join(" ") : "Sign-in is handled by your organisation's identity provider. You return to the page you asked for.";
}

export function SignIn({ config, error, needs }: { config: PublicConfig | null; error?: string | null; needs?: string | null }) {
  const demo = !!config?.demoAccounts;
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const go = (method: "sso" | "github", hint?: string) => window.location.assign(loginUrl(method, hint));
  const emailOn = config?.emailLinkLogin === true;
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const sendLink = (e?: FormEvent) => {
    e?.preventDefault();
    const msg = emailProblem(email, config?.allowedDomain);
    setProblem(msg);
    if (msg) emailRef.current?.focus();
    else go("sso", email.trim());
  };
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
              <span className="tok run" style={{ width: 110, display: "inline-flex" }}><span className="id">WO-1004</span><span className="pr p1">P1</span></span>
              <span className="tok is-gate" style={{ width: 110, marginLeft: 80, display: "inline-flex" }}><span className="id">WO-1021 ⏸</span><span className="pr">P2</span></span>
            </div>
          </div>
        </div>
      </section>
      <div className="form">
        {needs === "mfa_setup" ? (
          <MfaSetup />
        ) : (
          <form className="box" id="signin" noValidate onSubmit={sendLink} aria-labelledby="auth-h">
            <div>
              <h2 id="auth-h" style={{ font: "700 20px/28px var(--font)" }}>Sign in</h2>
              <p className="muted">{demo ? "Use your company account. Demo accounts are listed below." : "Use your company account."}</p>
            </div>
            {error ? (
              <div className="callout callout-block" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
              </div>
            ) : null}
            <Btn label={`Continue with ${config?.idpName ?? "SSO"}`} kind="primary" id="auth-sso-go" onClick={() => go("sso")} />
            <div className="row" style={{ gap: 12 }}>
              <span className="divider" style={{ flex: 1 }} />
              <span className="dim">or</span>
              <span className="divider" style={{ flex: 1 }} />
            </div>
            <div className={`field${problem ? " invalid" : ""}`} data-f="email">
              <label htmlFor="f-email">Work email <span className="dim">(required)</span></label>
              <TextInput
                ref={emailRef}
                id="f-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={config?.allowedDomain ? `you@${config.allowedDomain}` : "you@company.com"}
                value={email}
                disabled={!emailOn}
                aria-required="true"
                aria-invalid={problem ? true : undefined}
                aria-describedby="f-email-err"
                onChange={(e) => setEmail(e.target.value)}
              />
              <span className="err" id="f-email-err" role="alert">{problem}</span>
              {emailOn ? null : <span className="hint" id="f-email-na">Email sign-in links are not available on this server.</span>}
            </div>
            <Btn label="Email me a sign-in link" id="auth-email-link" disabledReason={emailOn ? null : "Email sign-in links are not available on this server."} onClick={() => sendLink()} />
            <Btn label="Continue with GitHub" id="auth-gh" icon="github" disabledReason={config?.githubLogin === false ? "GitHub sign-in is turned off in Security settings." : null} onClick={() => go("github")} />
            <div className="dim auth-foot">{signInFootnote(config)}</div>
            {demo ? (
              <div className="auth-demo">
                <h2 className="auth-demo-h">Demo accounts<span>one click, development only</span></h2>
                <p className="dim auth-foot">Development sign-in is on: seeded demo accounts can sign in. Use this only on a local stack.</p>
                <ul className="demo-list">
                  {accounts.map((d) => (
                    <li key={d.id}>
                      <a className="demo-acc" id={`demo-${d.id}`} href={loginUrl("sso", d.email)}>
                        <span className="av av-person av-sm" aria-hidden="true">
                          {d.name
                            .split(" ")
                            .map((w) => w[0] ?? "")
                            .join("")
                            .slice(0, 2)}
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
