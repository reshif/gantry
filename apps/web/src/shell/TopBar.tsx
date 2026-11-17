/** Top bar: brand, environment badge, breadcrumb, palette button, status cluster, inbox, user menu. */
import { useRef } from "react";
import { useHome } from "../api/queries";
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import { applyTheme, setProject, updatePrefs, usePrefs, type Theme } from "../lib/prefs";
import { Icon, Logo } from "../ui/Icon";
import { Avatar } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { StatusCluster } from "./StatusCluster";
import { ConnectionIndicator } from "../lib/connection/ConnectionIndicator";
import { useOpenTraveler } from "./useTraveler";
import { navigate } from "../lib/router";
import { isProjectRoute } from "../lib/routes";

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || "");

export function TopBar({ me, crumb, project, current, onOpenNav, onOpenPalette }: { me: Me; crumb: string[]; project: Me["projects"][number] | null; current: string; onOpenNav: () => void; onOpenPalette: () => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const home = useHome().data;
  const inboxRef = useRef<HTMLButtonElement>(null);
  const userRef = useRef<HTMLButtonElement>(null);
  const n = (home?.approvals.length ?? 0) + (home?.conversations.length ?? 0);
  const v = me.person;
  
  const signOut = async (what?: string) => {
    ui.closeAllDialogs();
    ui.drawer.close();
    const r = await ops.signOut();
    ui.toast(r.ok ? (what ?? "Signed out.") : r.msg, r.ok ? "info" : "error");
  };

  const setTheme = (t: Theme) => {
    updatePrefs({ theme: t });
    applyTheme(t);
  };

  const openUserMenu = () => {
    if (!userRef.current) return;
    const theme = prefs.theme;
    ui.menu(userRef.current, `${v.name} · ${v.email}`, [
      ...(me.config.demoAccounts ? [{ label: "Environment: local stack · demo accounts on", icon: "info" }, { sep: true }] : []),
      { label: "Account", icon: "user", onClick: () => navigate("account") },
      { sep: true },
      { label: "Theme: system", icon: "auto", hint: theme === "system" ? "on" : "", onClick: () => setTheme("system") },
      { label: "Theme: light", icon: "sun", hint: theme === "light" ? "on" : "", onClick: () => setTheme("light") },
      { label: "Theme: dark", icon: "moon", hint: theme === "dark" ? "on" : "", onClick: () => setTheme("dark") },
      { sep: true },
      ...(me.config.demoAccounts ? [{ label: "Switch demo account (demo only)", icon: "swap", onClick: () => void signOut("Signed out. Pick another demo account.") }] : []),
      { label: "Sign out", icon: "logout", onClick: () => void signOut() },
    ]);
  };

  const openInbox = () => {
    if (!inboxRef.current) return;
    ui.popover(inboxRef.current, (close) => <InboxBody name={v.name} close={close} />);
  };

  return (
    <header className="topbar" id="topbar">
      <button type="button" className="icon-btn nav-toggle" aria-label="Toggle navigation" aria-controls="nav" onClick={onOpenNav}>
        <Icon name="menu" />
      </button>
      <a href="#home" className="brand">
        <Logo />
        <span className="brand-name">Gantry</span>
        {me.config.demoAccounts ? <span className="dev-dot" role="img" aria-label="Non-production: local stack, demo accounts on" title="Non-production: local stack, demo accounts on" /> : null}
      </a>
      <ProjectSwitcher me={me} project={project} current={current} />
      <nav className={`crumb${isProjectRoute(current) ? "" : " crumb-factory"}`} id="crumb" aria-label="Breadcrumb">
        {crumb.map((c, i) => (
          <span key={i} className={i === crumb.length - 1 ? "crumb-cur" : "crumb-part"} aria-current={i === crumb.length - 1 ? "page" : undefined}>{c}</span>
        ))}
      </nav>
      <button type="button" className="palette-btn" id="palette-btn" onClick={onOpenPalette} aria-label="Open command palette">
        <Icon name="search" />
        <span className="palette-label">Search</span>
        <kbd>{isMac() ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <div className="top-right">
        <ConnectionIndicator />
        <StatusCluster />
        <button ref={inboxRef} type="button" className="icon-btn inbox-btn" id="inbox-btn" aria-label={`Waiting for you: ${n}`} aria-haspopup="dialog" aria-expanded="false" onClick={openInbox}>
          <Icon name="bell" />
          {n ? <span className="inbox-count mono">{String(n)}</span> : null}
        </button>
        <button ref={userRef} type="button" className="user-btn" id="user-menu" aria-haspopup="menu" aria-label={`Account menu for ${v.name}`} aria-expanded="false" title={me.config.demoAccounts ? `${v.name} · non-production: local stack, demo accounts on` : v.name} onClick={openUserMenu}>
          <Avatar id={v.id} size="sm" />
          {me.config.demoAccounts ? <span className="env-dot" aria-hidden="true" /> : null}
          <Icon name="down" />
        </button>
      </div>
    </header>
  );
}

function InboxBody({ name, close }: { name: string; close: () => void }) {
  const home = useHome().data;
  const openTraveler = useOpenTraveler();
  const ap = home?.approvals ?? [];
  const conv = home?.conversations ?? [];
  const item = (key: string, icon: string, main: string, sub: string, fn: () => void) => (
    <li key={key}>
      <button type="button" className="inbox-item" onClick={() => { close(); fn(); }}>
        <Icon name={icon} className="c-wait" />
        <span className="inbox-main">
          <span>{main}</span>
          <span className="muted small">{sub}</span>
        </span>
      </button>
    </li>
  );
  return (
    <div>
      <div className="pop-head">
        <strong>{`Waiting for ${name}`}</strong>
        <span className="muted small">{`${ap.length} approvals · ${conv.length} conversations`}</span>
      </div>
      {ap.length + conv.length ? (
        <ul className="inbox">
          {ap.map((a, i) =>
            a.repo
              ? item(`r${i}`, "rocket", a.note ? `Onboarding ${a.repoName ?? a.repo}` : `Merge onboarding PR ${a.repoName ?? a.repo}#${a.pr ?? ""}`, a.note ?? "Checks green", () => {
                  if (a.project) setProject(a.project);
                  navigate("onboarding", a.repo);
                })
              : item(`a${i}`, "st-wait", `${a.wo} · ${a.gateLabel ?? a.gate ?? ""} ${a.gateName ?? ""}`.trim(), `${a.title ?? ""} · ${a.projectName ?? a.project ?? ""}`, () => a.wo && openTraveler(a.wo)),
          )}
          {conv.map((w) =>
            item(`c${w.wo}`, "chat", `${w.wo} · questions for you`, w.title, () => {
              updatePrefs({ project: w.project, openConversation: w.wo });
              navigate("conversations");
            }),
          )}
        </ul>
      ) : (
        <div className="empty">
          <div className="empty-title">Nothing waiting for you</div>
          <p>Approvals you may give and questions addressed to you appear here.</p>
        </div>
      )}
      <div className="pop-foot">
        <button type="button" className="btn btn-sm" id="inbox-open-page" onClick={() => { close(); navigate("inbox"); }}>Open Inbox</button>
      </div>
    </div>
  );
}

