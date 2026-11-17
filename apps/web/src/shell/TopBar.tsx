/** Top bar: brand, environment badge, breadcrumb, palette button, status cluster, inbox, user menu. */
import { useRef } from "react";
import { useHome } from "../api/queries";
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import { applyTheme, setProject, updatePrefs, usePrefs, type Theme } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { CrIcon } from "../ui/cr";
import { Avatar } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useOpenTraveler } from "./useTraveler";
import { navigate } from "../lib/router";

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

  const themes: Array<[Theme, string, string]> = [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["system", "System (follows your device)", "auto"]];
  const themeMenu = (anchor: HTMLElement) =>
    ui.menu(anchor, "Theme", themes.map(([t, label, icon]) => ({ label: label.split(" ")[0] ?? label, icon, hint: prefs.theme === t ? "on" : "", onClick: () => setTheme(t) })));
  const themeIcon = prefs.theme === "light" ? "sun" : prefs.theme === "dark" ? "moon" : "auto";

  return (
    <header className="top" id="topbar" role="banner">
      <button type="button" className="iconbtn menu-btn" aria-label="Toggle navigation" aria-controls="nav" onClick={onOpenNav}>
        <CrIcon name="menu" />
      </button>
      <a href="#home" className="brand" aria-label="Gantry home">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M5 14h14" stroke="currentColor" strokeWidth="2" /><path d="M7 14V8h4v6M13 14V6h4v8" fill="none" stroke="var(--accent)" strokeWidth="1.8" /></svg>
        <span>GANTRY<br /><small>CONTROL ROOM</small></span>
        {me.config.demoAccounts ? <span className="dev-dot" role="img" aria-label="Non-production: local stack, demo accounts on" title="Non-production: local stack, demo accounts on" /> : null}
      </a>
      <ProjectSwitcher me={me} project={project} current={current} />
      <nav className="crumb-sr sr" id="crumb" aria-label="Breadcrumb">
        {crumb.map((c, i) => <span key={i} aria-current={i === crumb.length - 1 ? "page" : undefined}>{i ? " / " : ""}{c}</span>)}
      </nav>
      <div className="grow" />
      <button type="button" className="pill-btn" id="palette-btn" onClick={onOpenPalette} aria-label="Open command palette">
        <CrIcon name="search" />
        <span className="hide-m muted" style={{ minWidth: 120, textAlign: "left" }}>Search or jump to…</span>
        <kbd className="hide-m">{isMac() ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <div className="themesw" role="group" aria-label="Theme">
        {themes.map(([t, label, icon]) => (
          <button key={t} type="button" aria-pressed={prefs.theme === t} aria-label={`${label.split(" ")[0]} theme`} title={label} onClick={() => setTheme(t)}>
            <CrIcon name={icon} />
          </button>
        ))}
      </div>
      <button type="button" className="iconbtn themebtn" aria-label={`Theme: ${prefs.theme}`} title={`Theme: ${prefs.theme}`} aria-haspopup="menu" onClick={(e) => themeMenu(e.currentTarget)}>
        <CrIcon name={themeIcon} />
      </button>
      <button ref={inboxRef} type="button" className="iconbtn inbox-btn" id="inbox-btn" aria-label={`Waiting for you: ${n}`} aria-haspopup="dialog" aria-expanded="false" onClick={openInbox}>
        <CrIcon name="bell" />
        {n ? <span className="dot" /> : null}
      </button>
      <button ref={userRef} type="button" className="iconbtn user-btn" id="user-menu" aria-haspopup="menu" aria-label={`Account menu for ${v.name}`} aria-expanded="false" title={me.config.demoAccounts ? `${v.name} · non-production: local stack, demo accounts on` : v.name} style={{ width: "auto", padding: "0 4px" }} onClick={openUserMenu}>
        <Avatar id={v.id} size="sm" />
      </button>
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

