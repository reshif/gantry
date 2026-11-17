/**
 * Sign-in screen (legacy auth.js). Sign-in is delegated to the identity provider: the buttons leave
 * the SPA for /auth/login. Demo accounts appear only when the API config says demoAccounts is on.
 */
import { STATIONS } from "@gantry/domain";
import type { PublicConfig } from "../api/types";
import { loginUrlWithReturn as loginUrl } from "../lib/session/returnTo";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { Icon, Logo } from "../ui/Icon";
import { Btn } from "../ui/primitives";

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
  const go = (method: "sso" | "github") => window.location.assign(loginUrl(method));
  return (
    <div id="auth" className="auth signin">
        <section className="auth-brand art" aria-label="About Gantry">
          <div className="auth-logo row" style={{ gap: 12 }}>
            <Logo />
            <b className="brand-name" style={{ fontSize: 18, letterSpacing: ".04em" }}>GANTRY</b>
          </div>
          <div>
            <div className="label">Control room</div>
            <h1 className="auth-title" style={{ font: "700 36px/44px var(--font)", maxWidth: "14ch", margin: "8px 0" }}>Agents propose. People approve.</h1>
            <p className="auth-lede muted" style={{ maxWidth: "40ch" }}>Sign in to run the line: watch work travel the belt, decide at gates and keep every change on the record.</p>
          </div>
          <div>
            <ol className="auth-belt" aria-label="Stations">
              {STATIONS.map((s) => (
                <li key={s.id}>
                  <span className="mono">{s.no}</span>
                  {s.name}
                </li>
              ))}
            </ol>
            <p className="auth-note auth-demo-note">
              <Icon name={demo ? "alert" : "key"} />
              <span>{demo ? "Development sign-in is on: seeded demo accounts can sign in. Use this only on a local stack." : "Sign-in is handled by your organisation's identity provider. You return to the page you asked for."}</span>
            </p>
          </div>
        </section>
        <div className="form">
        {needs === "mfa_setup" ? <MfaSetup /> : <section className="auth-panel box" aria-labelledby="auth-h">
          <div>
            <h1 className="auth-h" id="auth-h">{`Sign in to ${config?.orgName ?? "Gantry"}`}</h1>
            <p className="muted auth-sub">{demo ? "Choose how to sign in. Demo accounts are listed below." : "Choose how to sign in."}</p>
          </div>
          {error ? (
            <div className="callout callout-block" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          ) : null}
          <Btn label="Continue with SSO" kind="primary" id="auth-sso-go" icon="key" onClick={() => go("sso")} />
          <div className="auth-or">
            <span>or</span>
          </div>
          <Btn label="Continue with GitHub" id="auth-gh" icon="github" disabledReason={config?.githubLogin === false ? "GitHub sign-in is turned off in Security settings." : null} onClick={() => go("github")} />
          {demo ? (
            <div className="auth-demo">
              <h2 className="auth-demo-h">Demo accounts<span>one click, development only</span></h2>
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
        </section>}
        </div>
    </div>
  );
}
