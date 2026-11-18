/**
 * Sign-in screen (legacy auth.js). Sign-in is delegated to the identity provider: the buttons leave
 * the SPA for /auth/login. Demo accounts appear only when the API config says demoAccounts is on.
 */
import { useState } from "react";
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { Icon } from "../ui/Icon";
import { Btn, Field } from "../ui/primitives";
import { applyTheme, usePrefs } from "../lib/prefs";
import { BrandMark } from "./Nav";

/** The guided screen for a Factory Admin whose sign-in had no second factor (the server answered `needs: "mfa_setup"`). */
function MfaSetup() {
  const sp = new URLSearchParams({ mfa: "1" });
  if (window.location.hash.length > 1) sp.set("return_to", `/${window.location.hash}`);
  return (
    <section className="panel auth-panel" aria-labelledby="mfa-h" id="auth-mfa">
      <div className="body stack">
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
      </div>
    </section>
  );
}

export function SignIn({ config, error, needs }: { config: PublicConfig | null; error?: string | null; needs?: string | null }) {
  const [email, setEmail] = useState("");
  const demo = !!config?.demoAccounts;
  const prefs = usePrefs();
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const go = (method: "sso" | "github") => window.location.assign(loginUrl(method));
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <main id="auth" className="auth signin">
      {needs === "mfa_setup" ? <MfaSetup /> : (
        <section className="panel" aria-labelledby="auth-h">
          <div className="body">
            <div className="row" style={{ marginBottom: 16 }}>
              <BrandMark />
              <div>
                <h1 id="auth-h" style={{ fontSize: 22 }}>Gantry</h1>
                <div className="micro">SOFTWARE FACTORY · SIGN-IN SHEET</div>
              </div>
            </div>
            {error ? (
              <div className="callout callout-block" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
              </div>
            ) : null}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // the identity provider asks for the password: the work email travels as its login hint
                window.location.assign(loginUrl("sso", email.trim() || undefined));
              }}
            >
              <Field label="Work email" htmlFor="auth-email">
                <input id="auth-email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Btn label="Sign in" kind="primary" id="auth-sso-go" type="submit" cls="block" />
            </form>
            <div className="row auth-or" style={{ margin: "12px 0" }}>
              <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
              <span className="small muted">or</span>
              <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
            </div>
            <Btn label="Continue with SSO" id="auth-sso" cls="block" onClick={() => go("sso")} />
            {config?.githubLogin === false ? null : <Btn label="Continue with GitHub" kind="ghost" id="auth-gh" icon="github" cls="block" onClick={() => go("github")} />}
            <p className="small muted" style={{ marginTop: 12 }}>MFA is required for admins.</p>
            {demo ? (
              <div className="auth-demo">
                <h2 className="auth-demo-h micro">Demo accounts · one click, development only</h2>
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
            <div className="row" style={{ marginTop: 8 }}>
              <Btn kind="ghost" small icon={dark ? "moon" : "sun"} label="Theme" onClick={() => applyTheme(dark ? "light" : "dark")} />
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
