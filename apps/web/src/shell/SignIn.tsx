/**
 * Sign-in screen in the Blueprint prototype's markup: one centred card (main.signin > .panel). Sign-in is delegated to
 * the identity provider: the buttons leave the SPA for /auth/login. Demo accounts appear only when the API config says
 * demoAccounts is on. There is no email/password form because the API offers no password login (backend gap).
 */
import { useState } from "react";
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { applyTheme, updatePrefs, usePrefs } from "../lib/prefs";
import { Icon, Logo } from "../ui/Icon";
import { Btn } from "../ui/primitives";

function Brand({ sub }: { sub: string }) {
  return (
    <div className="row" style={{ marginBottom: 16 }}>
      <span className="brand-mark" style={{ width: 30, height: 30, display: "inline-grid", placeItems: "center" }}><Logo /></span>
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

/** The guided screen for a Factory Admin whose sign-in had no second factor (the server answered `needs: "mfa_setup"`). */
function MfaSetup() {
  const sp = new URLSearchParams({ mfa: "1" });
  if (window.location.hash.length > 1) sp.set("return_to", `/${window.location.hash}`);
  return (
    <div id="auth-mfa" aria-labelledby="auth-h" role="region">
      <Brand sub="SOFTWARE FACTORY · TWO-STEP SIGN-IN" />
      <h2 className="auth-h" id="mfa-h" style={{ fontSize: 16, marginBottom: 6 }}>Set up two-step sign-in</h2>
      <p className="muted small">Factory Admins can stop the line and change who may do what, so they sign in with a password and a one-time code.</p>
      <ol className="auth-steps" style={{ margin: "12px 0" }}>
        <li>Install an authenticator app on your phone (any app that makes six-digit codes).</li>
        <li>Continue below and sign in. Your identity provider shows a QR code the first time: scan it and enter the code it gives you.</li>
        <li>Next time, you enter the code from the app after your password.</li>
      </ol>
      <Btn label="Set up and sign in" kind="primary" id="auth-mfa-go" icon="key" cls="block" onClick={() => window.location.assign(`/auth/login?${sp.toString()}`)} />
      <p className="muted small" style={{ marginTop: 12 }}>If you have lost your authenticator app, ask another Factory Admin or your identity provider's administrator to reset it.</p>
      <div className="row" style={{ marginTop: 8 }}><ThemeBtn /></div>
    </div>
  );
}

export function SignIn({ config, error, needs }: { config: PublicConfig | null; error?: string | null; needs?: string | null }) {
  const demo = !!config?.demoAccounts;
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const [pending, setPending] = useState<"sso" | "github" | null>(null);
  const go = (method: "sso" | "github") => { setPending(method); window.location.assign(loginUrl(method)); };
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <main className="signin" id="main">
        <div className="panel" style={{ width: "min(420px,100%)" }}>
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
                <Btn label={pending === "sso" ? "Opening your identity provider..." : "Sign in with SSO"} kind="primary" id="auth-sso-go" icon="key" cls="block" disabledReason={pending ? "Signing in" : null} onClick={() => go("sso")} />
                <div className="row auth-or" style={{ margin: "12px 0" }}>
                  <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
                  <span className="small muted">or</span>
                  <hr style={{ flex: 1, border: 0, borderTop: "1px solid var(--line)" }} />
                </div>
                <Btn label="Continue with GitHub" id="auth-gh" icon="github" cls="block" disabledReason={config?.githubLogin === false ? "GitHub sign-in is turned off in Security settings." : pending ? "Signing in" : null} onClick={() => go("github")} />
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
                  {demo ? "MFA is required for admins. Development sign-in is on: use it only on a local stack." : "MFA is required for admins. Sign-in is handled by your organisation's identity provider."}
                </p>
                <div className="row" style={{ marginTop: 8 }}><ThemeBtn /></div>
              </>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
