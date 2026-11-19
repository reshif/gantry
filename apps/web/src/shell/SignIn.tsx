/**
 * Sign-in screen in the Blueprint prototype's markup: one centred card (main.signin > .panel). Sign-in is delegated to
 * the identity provider: the buttons leave the SPA for /auth/login. Demo accounts appear only when the API config says
 * demoAccounts is on. The card carries the prototype's Work email / Password fields: the email goes to the identity provider as a
 * login hint, the password is asked by the provider itself (the API offers no password login: backend gap), so that field is shown disabled.
 */
import { useState } from "react";
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { applyTheme, updatePrefs, usePrefs } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { Btn, Field, TextInput } from "../ui/primitives";
import "../styles/views/signin.css";

/** The prototype's brand mark: a framed grid square with the accent dot (brandMark() in js/shell.js). */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="var(--accent)" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" />
      <path d="M3 12h26M3 20h26M12 3v26M20 3v26" strokeWidth=".8" opacity=".6" />
      <circle cx="16" cy="16" r="5" fill="var(--accent)" />
    </svg>
  );
}

function Brand({ sub }: { sub: string }) {
  return (
    <div className="row" style={{ marginBottom: 16 }}>
      <BrandMark />
      <div>
        <h1 style={{ fontSize: 22 }} id="auth-h">Gantry</h1>
        <div className="micro">{sub}</div>
      </div>
    </div>
  );
}

function ThemeBtn() {
  const prefs = usePrefs();
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  return <Btn small kind="ghost" id="auth-theme" icon={dark ? "moon" : "sun"} label="Theme" onClick={() => { updatePrefs({ theme: next }); applyTheme(next); }} />;
}

/** The guided screen for a person whose sign-in had no second factor (the server answered `needs: "mfa_setup"`): MFA is required for everyone. */
function MfaSetup() {
  const sp = new URLSearchParams();
  if (window.location.hash.length > 1) sp.set("return_to", `/${window.location.hash}`);
  return (
    <div id="auth-mfa" aria-labelledby="auth-h" role="region">
      <Brand sub="SOFTWARE FACTORY · TWO-STEP SIGN-IN" />
      <h2 className="auth-h" id="mfa-h" style={{ fontSize: 16, marginBottom: 6 }}>Two-step sign-in is required</h2>
      <p className="muted small">Everyone signs in with a password and a second factor: an authenticator app, a security key or a recovery code.</p>
      <ol className="auth-steps" style={{ margin: "12px 0" }}>
        <li>Open the one-time link your identity provider emailed you. It makes you choose a password and set up an authenticator app, and shows recovery codes to keep.</li>
        <li>Then sign in below: your password first, then the code from the app.</li>
      </ol>
      <Btn label="Sign in with two steps" kind="primary" id="auth-mfa-go" icon="key" cls="block" onClick={() => window.location.assign(`/auth/login${sp.size ? `?${sp.toString()}` : ""}`)} />
      <p className="muted small" style={{ marginTop: 12 }}>No link, or it expired? Ask an administrator to send you a new one (People, Reset authenticator). The link works once and lasts one hour. Your password alone never lets you set up an authenticator.</p>
      <div className="row" style={{ marginTop: 8 }}><ThemeBtn /></div>
    </div>
  );
}

export function SignIn({ config, error, needs }: { config: PublicConfig | null; error?: string | null; needs?: string | null }) {
  const demo = !!config?.demoAccounts;
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const [pending, setPending] = useState<"sso" | "github" | null>(null);
  const [email, setEmail] = useState(() => (config?.demoAccounts ? (config.demoAccountList?.[0]?.email ?? DEMO_ACCOUNTS[0]?.email ?? "") : ""));
  const [password, setPassword] = useState("");
  const go = (method: "sso" | "github") => { setPending(method); window.location.assign(loginUrl(method)); };
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <main className="signin" id="main">
        <form className="panel" style={{ width: "min(420px,100%)" }} onSubmit={(e) => { e.preventDefault(); if (needs !== "mfa_setup" && !pending) { setPending("sso"); window.location.assign(loginUrl("sso", email.trim() || undefined)); } }}>
          <div className="body">
            {needs === "mfa_setup" ? <MfaSetup /> : (
              <>
                <Brand sub="SOFTWARE FACTORY · SIGN-IN SHEET" />
                {error ? (
                  <div className="callout bad" role="alert" style={{ marginBottom: 12 }}>
                    <b>Sign-in failed</b>
                    {error}
                  </div>
                ) : null}
                <Field label="Work email">
                  <TextInput id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.com" />
                </Field>
                <Field label="Password">
                  <TextInput id="auth-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </Field>
                <Btn label={pending === "sso" ? "Opening your identity provider..." : "Sign in"} kind="primary" type="submit" id="auth-sso-go" cls="block" disabledReason={pending ? "Signing in" : null} />
                <div className="row" style={{ margin: "12px 0" }}>
                  <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
                  <span className="small muted">or</span>
                  <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
                </div>
                <Btn label="Continue with Okta SSO" id="auth-sso" cls="block" disabledReason={pending ? "Signing in" : null} onClick={() => go("sso")} />
                {config?.githubLogin === true ? <Btn label="Continue with GitHub" id="auth-gh" cls="block" disabledReason={pending ? "Signing in" : null} onClick={() => go("github")} /> : null}
                {demo ? (
                  <div className="auth-demo" style={{ marginTop: 12 }}>
                    <h2 className="micro auth-demo-h">Demo accounts · development only</h2>
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
                <p className="small muted" style={{ marginTop: 12 }}>
                  MFA is required for everyone.{demo ? " Development sign-in is on." : ""}
                </p>
                <div className="row" style={{ marginTop: 8 }}><ThemeBtn /></div>
              </>
            )}
          </div>
        </form>
      </main>
    </>
  );
}
