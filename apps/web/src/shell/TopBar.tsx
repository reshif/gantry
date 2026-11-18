/** Top bar: hamburger, brand, project switcher, search, theme switch and menu, notifications bell, user menu. */
import { useEffect, useRef } from "react";
import { ops } from "../api/ops";
import type { Me } from "../api/types";
import { applyTheme, updatePrefs, usePrefs, type Theme } from "../lib/prefs";
import { CrIcon } from "../ui/cr";
import { Avatar } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { navigate } from "../lib/router";
import { DEMO_ACCOUNTS } from "../lib/demo";
import { loginUrlWithReturn } from "../lib/session/returnTo";
import { MenuDivider, MenuHead, MenuRow, CrMenu } from "./CrMenu";
import { useNotifications, useOpenNotifications } from "./NotificationsDrawer";
import { ProjectSwitcher } from "./ProjectSwitcher";

export const SWITCH_KEY = "gantry.personaSwitch";
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || "");

/** Theme choices in the order the prototype's menu lists them. */
const THEME_MENU: Array<[Theme, string, string]> = [["system", "System", "auto"], ["dark", "Dark", "moon"], ["light", "Light", "sun"]];
const THEME_SWITCH: Array<[Theme, string, string]> = [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["system", "System (follows your device)", "auto"]];

export function TopBar({ me, crumb, project, current, navOpen, onOpenNav, onOpenPalette }: { me: Me; crumb: string[]; project: Me["projects"][number] | null; current: string; navOpen: boolean; onOpenNav: () => void; onOpenPalette: () => void }) {
  const ui = useUI();
  const prefs = usePrefs();
  const notif = useNotifications();
  const openNotifications = useOpenNotifications();
  const userRef = useRef<HTMLButtonElement>(null);
  const v = me.person;
  const roleNames = Array.from(new Set(v.roles.map((g) => g.role.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "))));
  const subtitle = [v.title, roleNames.join(", ")].filter(Boolean).join(" · ");

  // A persona switch is a sign-in round trip (the identity provider signs the other account in), so the confirmation toast
  // is shown here, on the page the person comes back to, once the session really is that person.
  useEffect(() => {
    try {
      const want = window.sessionStorage.getItem(SWITCH_KEY);
      if (!want) return;
      window.sessionStorage.removeItem(SWITCH_KEY);
      if (want === v.name) ui.toast(`Now viewing as ${v.name}`, "info");
    } catch { /* storage blocked: no toast */ }
  }, [v.name, ui]);

  const signOut = async (what?: string) => {
    ui.closeAllDialogs();
    ui.drawer.close();
    const r = await ops.signOut();
    ui.toast(r.ok ? (what ?? "Signed out.") : r.msg, r.ok ? "info" : "error");
  };

  /** Demo accounts the person can switch to: the server's list when it sends one, else the seeded users; the prototype's four personas first. */
  const personas = (() => {
    const list = me.config.demoAccountList?.length ? me.config.demoAccountList : DEMO_ACCOUNTS;
    const first = ["asha", "meera", "tom", "sam"].map((n) => list.find((d) => d.name.toLowerCase().startsWith(n))).filter((d): d is (typeof list)[number] => !!d);
    return (first.length ? first : list.slice(0, 4));
  })();
  /** Switching signs out and signs in as that account: the identity provider does the real work. */
  const switchTo = async (d: (typeof personas)[number]) => {
    ui.closeAllDialogs();
    ui.drawer.close();
    try { window.sessionStorage.setItem(SWITCH_KEY, d.name); } catch { /* storage blocked */ }
    const r = await ops.signOut();
    if (r.ok) window.location.assign(loginUrlWithReturn("sso", d.email));
    else {
      try { window.sessionStorage.removeItem(SWITCH_KEY); } catch { /* storage blocked */ }
      ui.toast(r.msg, "error");
    }
  };

  const setTheme = (t: Theme) => {
    updatePrefs({ theme: t });
    applyTheme(t);
  };

  const openUserMenu = () => {
    if (!userRef.current) return;
    ui.popover(
      userRef.current,
      (close) => (
        <CrMenu>
          <div className="mh">
            <b>{v.name}</b>
            <div className="dim" style={{ fontSize: 12 }}>{subtitle || v.email}</div>
          </div>
          <MenuRow icon="people" label="My account" onClick={() => { close(); navigate("account"); }} />
          {me.config.demoAccounts ? (
            <>
              <MenuDivider />
              <MenuHead>Switch persona (demo)</MenuHead>
              {personas.map((d) => (
                <MenuRow key={d.id} lead={<Avatar id={d.id} name={d.name} size="sm" />} label={d.name} tag={d.role === "Demo account" ? undefined : d.role} onClick={() => { close(); void switchTo(d); }} />
              ))}
            </>
          ) : null}
          <MenuDivider />
          <MenuRow icon="lock" label="Sign out" onClick={() => { close(); void signOut(); }} />
        </CrMenu>
      ),
      undefined,
      { cls: "pop-cr", role: "menu", label: "Account menu", width: 260, align: "right" },
    );
  };

  const themeMenu = (anchor: HTMLElement) =>
    ui.popover(
      anchor,
      (close) => (
        <CrMenu>
          <MenuHead>Theme</MenuHead>
          {THEME_MENU.map(([t, label, icon]) => <MenuRow key={t} radio icon={icon} label={label} checked={prefs.theme === t} onClick={() => { close(); setTheme(t); }} />)}
        </CrMenu>
      ),
      undefined,
      { cls: "pop-cr", role: "menu", label: "Theme", width: 200, align: "right" },
    );
  const themeIcon = prefs.theme === "light" ? "sun" : prefs.theme === "dark" ? "moon" : "auto";

  return (
    <header className="top" id="topbar" role="banner">
      <button type="button" className="iconbtn menu-btn" aria-label="Open navigation" aria-controls="nav" aria-expanded={navOpen} onClick={onOpenNav}>
        <CrIcon name="menu" />
      </button>
      <a href="#home" className="brand" aria-label="Gantry home">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M5 14h14" stroke="currentColor" strokeWidth="2" /><path d="M7 14V8h4v6M13 14V6h4v8" fill="none" stroke="var(--accent)" strokeWidth="1.8" /></svg>
        <span>GANTRY<br /><small>CONTROL ROOM</small></span>
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
        {THEME_SWITCH.map(([t, label, icon]) => (
          <button key={t} type="button" aria-pressed={prefs.theme === t} aria-label={`${label.split(" ")[0]} theme`} title={label} onClick={() => setTheme(t)}>
            <CrIcon name={icon} />
          </button>
        ))}
      </div>
      <button type="button" className="iconbtn themebtn" aria-label={`Theme: ${prefs.theme}`} title={`Theme: ${prefs.theme}`} aria-haspopup="menu" aria-expanded="false" onClick={(e) => themeMenu(e.currentTarget)}>
        <CrIcon name={themeIcon} />
      </button>
      <button type="button" className="iconbtn" id="inbox-btn" aria-label="Notifications" aria-haspopup="dialog" onClick={openNotifications}>
        <CrIcon name="bell" />
        {notif.unread ? <span className="dot" /> : null}
      </button>
      <button ref={userRef} type="button" className="iconbtn user-btn" id="user-menu" aria-haspopup="menu" aria-label={`Account menu for ${v.name}`} aria-expanded="false" title={me.config.demoAccounts ? `${v.name} · non-production: local stack, demo accounts on` : v.name} style={{ width: "auto", padding: "0 4px" }} onClick={openUserMenu}>
        <Avatar id={v.id} size="sm" />
      </button>
    </header>
  );
}
