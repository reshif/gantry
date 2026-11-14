/** The signed-in app shell (legacy app.js): top bar, kill banner, left nav, main view and global keys. */
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { Me } from "../api/types";
import { useCanSession } from "../api/can";
import { VIEWS } from "../views";
import { useRegisterNewWorkOrder } from "../views/work-orders/New";
import { hasNoAccess, isProjectRoute, landingFor, pickProject, resolveRoute, routeDef } from "../lib/routes";
import { formatHash, replaceHash, useHash } from "../lib/router";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { Empty } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useInstallStepUp, useResumeStepUp } from "../ui/stepup";
import { useInstallOverrideReason } from "../ui/override";
import { makeStopActions } from "./stopActions";
import { Nav, useRouteAccess, useRouteCtx } from "./Nav";
import { PaletteDialog } from "./Palette";
import { StopBanner } from "./StopBanner";
import { TopBar } from "./TopBar";

class ViewBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="view">
          <Empty title="This screen failed to render" text={this.state.error.message} />
        </div>
      );
    }
    return this.props.children;
  }
}

export function Shell({ me }: { me: Me }) {
  const ui = useUI();
  const prefs = usePrefs();
  const loc = useHash();
  const ctx = useRouteCtx();
  useCanSession(me.session.id);
  // back from a step-up sign-in: reopen the kill/restore dialog the person left, with their draft
  useResumeStepUp((d) => makeStopActions(ui, me)[d.kind](d.scope as "factory" | "project" | "workorder", d.id), true);
  useInstallStepUp();
  useInstallOverrideReason();
  useRegisterNewWorkOrder();
  const [navOpen, setNavOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  const access = useRouteAccess(me);
  // empty hash: the landing rule. Legacy hashes (#floor) gain the project: `prefs.project` is only a default.
  const landing = loc.id === "" ? landingFor(me) : null;
  const wanted = landing?.id ?? loc.id;
  const resolved = resolveRoute(wanted, me, ctx);
  const permDenied = resolved.denied === null && wanted !== "home" && routeDef(wanted) && access.denied(wanted) ? routeDef(wanted)! : null;
  const routeId = permDenied ? "home" : resolved.id;
  const denied = permDenied ?? resolved.denied;
  const def = routeDef(routeId);
  const scoped = isProjectRoute(routeId);
  const urlProject = scoped ? (loc.project ?? landing?.project ?? pickProject(me, prefs.project)) : null;
  const project = me.projects.find((p) => p.id === urlProject) ?? null;
  const projectId = scoped ? (project?.id ?? null) : (pickProject(me, prefs.project) ?? null);
  const noProjectAccess = scoped && !!loc.project && !project;

  // redirect (replace, no dead back step) to the canonical form of the URL
  useLayoutEffect(() => {
    if (scoped && !loc.project && project) replaceHash(formatHash(routeId, loc.param, project.id));
    else if (loc.id === "" && landing) replaceHash(formatHash(landing.id, null, landing.project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, loc.project, loc.param, loc.id, project?.id, routeId]);

  // the URL wins: entering a project makes it the remembered one (views read it through prefs)
  const [synced, setSynced] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (scoped && loc.project && project) {
      if (prefs.project !== project.id || !prefs.recentProjects.includes(project.id)) setProject(project.id);
      setSynced(project.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, loc.project, project?.id]);

  // a route the person cannot see falls back to home with a notice
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (denied && warned.current !== denied.id + loc.param) {
      warned.current = denied.id + loc.param;
      ui.toast(`You do not have access to ${denied.title}.`, "warn");
    }
  }, [denied, loc.param, ui]);

  // new route: top of the page, focus moves to the main region
  useEffect(() => {
    const m = main.current;
    if (!m) return;
    m.scrollTop = 0;
    m.focus({ preventScroll: true });
    setNavOpen(false);
  }, [routeId, loc.param]);

  useEffect(() => {
    document.title = `${def?.title ?? "Home"}${scoped && project ? ` · ${project.name}` : ""} · Gantry Software Factory`;
  }, [def, scoped, project]);

  const openPalette = useCallback(() => {
    ui.open((close) => <PaletteDialog projectId={projectId} onClose={close} />);
  }, [ui, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openPalette();
      } else if (e.key === "Escape" && navOpen) setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPalette, navOpen]);

  const toggleNav = () => {
    let wide = true;
    try { wide = window.matchMedia("(min-width: 861px)").matches; } catch { /* assume desktop */ }
    if (wide) updatePrefs({ navRail: !prefs.navRail });
    else setNavOpen((o) => !o);
  };
  const View = VIEWS[routeId] ?? VIEWS.home;
  const noAccess = hasNoAccess(me);
  const crumb = scoped ? [def?.title ?? ""] : [...(def && !["Overview"].includes(def.group) ? [def.group] : []), def?.title ?? "Home"];
  const switcherProject = scoped ? project : (me.projects.find((p) => p.id === prefs.project) ?? null);
  const ready = !scoped || (!!project && synced === project.id);
  const killed = !!me.factory.killed;
  return (
    <div id="app" className={`shell${prefs.navRail ? " nav-rail" : ""}${navOpen ? " nav-open" : ""}`}>
      <TopBar me={me} crumb={crumb} project={switcherProject} current={routeId} onOpenNav={toggleNav} onOpenPalette={openPalette} />
      <div className="sysbanner" id="sysbanner" hidden={!killed}>
        {killed ? <StopBanner projectId={null} /> : null}
      </div>
      <Nav me={me} current={routeId} project={scoped ? project : null} onNavigate={() => setNavOpen(false)} />
      <div className="nav-scrim" id="nav-scrim" hidden={!navOpen} onClick={() => setNavOpen(false)} />
      <main className="main" id="main" tabIndex={-1} ref={main}>
        {def?.project && !killed ? <StopBanner projectId={projectId} /> : null}
        <ViewBoundary key={`${routeId}/${loc.param ?? ""}`}>
          {noAccess ? (
            <div className="view">
              <Empty id="no-access" title="No access yet" text="Ask a Factory Admin or Project Admin to give you a role. Until then only your own profile is available." />
            </div>
          ) : noProjectAccess ? (
            <div className="view">
              <Empty id="no-project-access" title="You do not have access to this project" text="It may not exist, or you hold no role on it. Projects you cannot see are hidden from you." action={<p><a href="#projects" className="linkish">Back to all projects</a></p>} />
            </div>
          ) : ready ? (
            <Suspense fallback={null}>{View ? <View /> : null}</Suspense>
          ) : null}
        </ViewBoundary>
      </main>
    </div>
  );
}
