/** The signed-in app shell (legacy app.js): top bar, kill banner, left nav, main view and global keys. */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppErrorBoundary } from "../lib/errors/AppErrorBoundary";
import { RouteSkeleton } from "./RouteSkeleton";
import type { Me } from "../api/types";
import { useCanSession } from "../api/can";
import { VIEWS } from "../views";
import { useRegisterNewWorkOrder } from "../views/work-orders/New";
import { hasNoAccess, isProjectRoute, landingFor, pickProject, resolveRoute, routeDef } from "../lib/routes";
import { formatHash, navigate, replaceHash, useHash } from "../lib/router";
import { setProject, updatePrefs, usePrefs } from "../lib/prefs";
import { useCrumbTailValue } from "../lib/crumb";
import { Empty } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useInstallStepUp, useResumeStepUp } from "../ui/stepup";
import { useInstallOverrideReason } from "../ui/override";
import { makeStopActions } from "./stopActions";
import { Nav, useRouteAccess, useRouteCtx } from "./Nav";
import { PaletteDialog } from "./Palette";
import { StatusBar } from "./StatusBar";
import { NotFoundPage } from "./StatePreview";
import { SHARED_STATES, SharedStatePage, protoEyebrow, type SharedStateKind } from "./SharedStates";
import { StopBanner } from "./StopBanner";
import { TopBar } from "./TopBar";
import { useRestoreTraveler } from "./useTraveler";

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
  useRestoreTraveler();
  const [navOpen, setNavOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  const access = useRouteAccess(me);
  // empty hash: the landing rule. Legacy hashes (#floor) gain the project: `prefs.project` is only a default.
  const landing = loc.id === "" ? landingFor(me) : null;
  const wanted = landing?.id ?? loc.id;
  const resolved = resolveRoute(wanted, me, ctx);
  const permDenied = resolved.denied === null && wanted !== "home" && routeDef(wanted) && access.denied(wanted) ? routeDef(wanted)! : null;
  const routeId = permDenied ? "home" : resolved.id;
  // a hash that names no page is a 404 of its own, not a silent Home
  const notFound = loc.id !== "" && !routeDef(wanted);
  const denied = permDenied ?? resolved.denied;
  const def = routeDef(routeId);
  const scoped = isProjectRoute(routeId);
  const urlProject = scoped ? (loc.project ?? landing?.project ?? pickProject(me, prefs.project)) : null;
  const project = me.projects.find((p) => p.id === urlProject) ?? null;
  const projectId = scoped ? (project?.id ?? null) : (pickProject(me, prefs.project) ?? null);
  const noProjectAccess = scoped && !!loc.project && !project;

  // redirect (replace, no dead back step) to the canonical form of the URL
  useLayoutEffect(() => {
    if (scoped && !loc.project && project) replaceHash(formatHash(routeId, loc.param, project.id) + (loc.query ? `?${loc.query}` : ""));
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


  // new route: top of the page, focus moves to the main region
  useEffect(() => {
    const m = main.current;
    if (!m) return;
    m.scrollTop = 0;
    m.focus({ preventScroll: true });
    setNavOpen(false);
  }, [routeId, loc.param]);

  useEffect(() => {
    document.title = `${notFound ? "Page not found" : (denied?.title ?? def?.title ?? "Home")}${scoped && project ? ` · ${project.name}` : ""} · Gantry Control Room`;
  }, [def, denied, scoped, project, notFound]);

  const openPalette = useCallback(() => {
    if (document.getElementById("palette-list")) return; // toggle-guarded: Ctrl+K while the palette is open does not stack a second one
    ui.open((close) => <PaletteDialog projectId={projectId} onClose={close} />);
  }, [ui, projectId]);

  useEffect(() => {
    let chord = 0;
    const typing = (t: EventTarget | null) => /^(input|textarea|select)$/i.test((t as HTMLElement | null)?.tagName ?? "") || !!(t as HTMLElement | null)?.isContentEditable;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openPalette();
      } else if (e.key === "Escape" && navOpen) setNavOpen(false);
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
        if (e.key === "?") ui.toast("Shortcuts: Ctrl+K palette, g then h Home, Esc closes", "info");
        else if (e.key === "g" && !document.querySelector("#layer-dialog > *, #layer-drawer > *")) chord = Date.now();
        else if (e.key === "h" && chord && Date.now() - chord < 1500) {
          chord = 0;
          navigate("home");
        } else chord = 0;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPalette, navOpen, ui]);

  const toggleNav = () => {
    let wide = true;
    try { wide = window.matchMedia("(min-width: 1101px)").matches; } catch { /* assume desktop */ }
    if (wide) updatePrefs({ navRail: !prefs.navRail });
    else setNavOpen((o) => !o);
  };
  const View = VIEWS[routeId] ?? VIEWS.home;
  const noAccess = hasNoAccess(me);
  const shown = denied ?? def;
  const crumbTail = useCrumbTailValue();
  const baseCrumb = scoped ? [def?.title ?? ""] : [...(shown && !["Overview"].includes(shown.group) ? [shown.group] : []), shown?.title ?? "Home"];
  // a detail page ends the trail with its record; "Agents › Agents › Builder" reads as a stutter, so the title that repeats its group is dropped
  const crumb = crumbTail && loc.param ? [...(baseCrumb.length > 1 && baseCrumb[0] === baseCrumb[baseCrumb.length - 1] ? baseCrumb.slice(0, -1) : baseCrumb), crumbTail] : baseCrumb;
  const switcherProject = scoped ? project : (me.projects.find((p) => p.id === prefs.project) ?? null);
  const ready = !scoped || (!!project && synced === project.id);
  const killed = !!me.factory.killed;
  return (
    <div id="app" className={`app${navOpen ? " nav-open" : ""}`}>
      <AppErrorBoundary level="chrome">
        <TopBar me={me} crumb={crumb} project={switcherProject} current={routeId} navOpen={navOpen} onOpenNav={toggleNav} onOpenPalette={openPalette} />
      </AppErrorBoundary>
      <AppErrorBoundary level="chrome">
        <Nav me={me} current={denied ? denied.id : routeId} project={scoped ? project : null} onNavigate={() => setNavOpen(false)} />
      </AppErrorBoundary>
      <div className="nav-scrim" id="nav-scrim" hidden={!navOpen} onClick={() => setNavOpen(false)} />
      <main className="main" id="main" tabIndex={-1} ref={main}>
        {killed ? <div className="sysbanner" id="sysbanner"><StopBanner projectId={null} /></div> : null}
        {def?.project && !killed ? <StopBanner projectId={projectId} /> : null}
        <AppErrorBoundary level="route" resetKey={`${routeId}/${loc.param ?? ""}`}>
          {notFound ? (
            <NotFoundPage name={loc.id} />
          ) : noAccess ? (
            <div className="view">
              <Empty id="no-access" title="No access yet" text="Ask a Factory Admin or Project Admin to give you a role. Until then only your own profile is available." />
            </div>
          ) : noProjectAccess ? (
            <div className="view">
              <Empty id="no-project-access" title="You do not have access to this project" text="It may not exist, or you hold no role on it. Projects you cannot see are hidden from you." action={<p><a href="#projects" className="linkish">Back to all projects</a></p>} />
            </div>
          ) : denied ? (
            // a page outside the person's roles: say so where they asked for it (the URL stays, so it works once access is granted)
            <div className="view">
              <Empty id="route-denied" icon="lock" title={`${denied.title} isn't available to your roles`} text="Your roles don't include this page. A Factory Admin can grant a role that does; until then it stays hidden from your menu." action={<p><a href="#home" className="linkish" id="route-denied-home">Go to Home</a></p>} />
            </div>
          ) : ready && (SHARED_STATES as readonly string[]).includes(loc.state ?? "") ? (
            <SharedStatePage kind={loc.state as SharedStateKind} eyebrow={protoEyebrow(routeId, def?.group ?? "")} title={def?.title ?? ""} />
          ) : ready ? (
            <Suspense fallback={<RouteSkeleton />}>{View ? <View /> : null}</Suspense>
          ) : null}
        </AppErrorBoundary>
      </main>
      <AppErrorBoundary level="chrome">
        <StatusBar />
      </AppErrorBoundary>
    </div>
  );
}
