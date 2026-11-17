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

export function SignIn({ config, error }: { config: PublicConfig | null; error?: string | null }) {
  const demo = !!config?.demoAccounts;
  const accounts = config?.demoAccountList?.length ? config.demoAccountList : DEMO_ACCOUNTS;
  const go = (method: "sso" | "github") => window.location.assign(loginUrl(method));
  return (
    <div id="auth" className="auth">
      <div className="auth-wrap">
        <section className="auth-brand" aria-label="About Gantry">
          <div className="auth-logo">
            <Logo />
            <span className="brand-name">Gantry</span>
          </div>
          <h1 className="auth-title">Software factory</h1>
          <p className="auth-lede">Run AI coding agents against your repos. People hold the gates, decide who can do what, and can stop the line at any time.</p>
          <ol className="auth-belt" aria-label="Stations">
            {STATIONS.map((s) => (
              <li key={s.id}>
                <span className="mono">{s.no}</span>
                {s.name}
              </li>
            ))}
          </ol>
          <p className="auth-note">Gantry shows nothing until you are signed in. After you sign in, you go back to the page you asked for.</p>
          <p className="auth-note auth-demo-note">
            <Icon name={demo ? "alert" : "key"} />
            <span>{demo ? "Development sign-in is on: seeded demo accounts can sign in. Use this only on a local stack." : "Sign-in is handled by your organisation's identity provider."}</span>
          </p>
        </section>
        <section className="auth-panel" aria-labelledby="auth-h">
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
        </section>
      </div>
    </div>
  );
}
