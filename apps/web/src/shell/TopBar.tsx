/** Top bar: brand, environment badge, breadcrumb, palette button, status cluster, inbox, user menu. */
import { useRef } from "react";
import { useHome } from "../api/queries";
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import { applyTheme, updatePrefs, usePrefs, type Theme } from "../lib/prefs";
import { Icon } from "../ui/Icon";
import { Avatar } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { StatusCluster } from "./StatusCluster";
import { openNotifications, useUnread } from "./NotificationsDrawer";
import { navigate } from "../lib/router";

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || "");

export function TopBar({ me, project, current, onOpenNav, onOpenPalette }: { me: Me; project: Me["projects"][number] | null; current: string; onOpenNav: () => void; onOpenPalette: () => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const home = useHome().data;
  const userRef = useRef<HTMLButtonElement>(null);
  const waiting = (home?.approvals.length ?? 0) + (home?.conversations.length ?? 0);
  const unread = useUnread(waiting);
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
    ui.menu(userRef.current, null, [
      { head: `${v.name} · ${v.email}` },
      ...(me.config.demoAccounts ? [{ label: "Environment: local stack · demo accounts on", icon: "info" }, { sep: true }] : []),
      { label: "My account", icon: "user", onClick: () => navigate("account") },
      { sep: true },
      ...(me.config.demoAccounts ? [{ label: "Switch demo account (demo only)", icon: "swap", onClick: () => void signOut("Signed out. Pick another demo account.") }] : []),
      { label: "Sign out", icon: "logout", onClick: () => void signOut() },
    ]);
  };

  const themeRef = useRef<HTMLButtonElement>(null);
  const openTheme = () => {
    if (!themeRef.current) return;
    ui.menu(themeRef.current, null, [
      { head: "Theme" },
      { label: "System", icon: "grid", sel: prefs.theme === "system", onClick: () => setTheme("system") },
      { label: "Light · paper drawing", icon: "sun", sel: prefs.theme === "light", onClick: () => setTheme("light") },
      { label: "Dark · blueprint", icon: "moon", sel: prefs.theme === "dark", onClick: () => setTheme("dark") },
    ]);
  };
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <header className="top" id="topbar" role="banner">
      <button type="button" className="btn icon ghost burger" aria-label="Open navigation" aria-controls="side" onClick={onOpenNav}>
        <Icon name="menu" />
      </button>
      <ProjectSwitcher me={me} project={project} current={current} />
      <button type="button" className="search-btn palette-btn" id="palette-btn" onClick={onOpenPalette} aria-label="Open command palette">
        <Icon name="search" />
        <span className="t palette-label">Search or jump to…</span>
        <kbd>{isMac() ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <div className="grow" />
      <StatusCluster />
      <button type="button" className="btn icon ghost inbox-btn" id="inbox-btn" aria-label="Notifications" title="Notifications" aria-haspopup="dialog" onClick={() => openNotifications(ui, waiting)}>
        <Icon name="bell" />
        {unread ? <span className="inbox-count mono" aria-hidden="true" /> : null}
      </button>
      <button ref={themeRef} type="button" className="btn icon ghost" aria-label={`Theme: ${prefs.theme}. Click to change`} title={`Theme: ${prefs.theme}`} aria-haspopup="menu" onClick={openTheme}>
        <Icon name={dark ? "moon" : "sun"} />
      </button>
      <button ref={userRef} type="button" className="btn ghost user-btn" id="user-menu" aria-haspopup="menu" aria-label={`Account menu for ${v.name}`} aria-expanded="false" title={me.config.demoAccounts ? `${v.name} · non-production: local stack, demo accounts on` : v.name} onClick={openUserMenu}>
        <Avatar id={v.id} size="sm" />
        <span className="trunc small" style={{ maxWidth: 110 }}>{v.name.split(" ")[0]}</span>
      </button>
    </header>
  );
}
