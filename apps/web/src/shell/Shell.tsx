/** The signed-in app shell (legacy app.js): top bar, kill banner, left nav, main view and global keys. */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppErrorBoundary } from "../lib/errors/AppErrorBoundary";
import { RouteSkeleton } from "./RouteSkeleton";
import type { Me } from "../api/types";
import { useCanSession } from "../api/can";
import { VIEWS } from "../views";
import { useRegisterNewWorkOrder } from "../views/work-orders/New";
import { hasNoAccess, isProjectRoute, landingFor, pickProject, resolveRoute, routeDef } from "../lib/routes";
import { clearGovernQS } from "../views/govern/kit";
import { formatHash, hashQuery, navigate, replaceHash, useHash } from "../lib/router";
import { setProject, usePrefs } from "../lib/prefs";
import { Btn, Empty, Panel, ViewHead } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { useInstallStepUp, useResumeStepUp } from "../ui/stepup";
import { useInstallOverrideReason } from "../ui/override";
import { makeStopActions } from "./stopActions";
import { Nav, useRouteAccess, useRouteCtx } from "./Nav";
import { PaletteDialog } from "./Palette";
import { ReadOnlyBanner, StopBanner, ViewAsBanner } from "./StopBanner";
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
  const denied = permDenied ?? resolved.denied;
  const def = routeDef(routeId);
  // an id no screen answers to: the Sheet not found page, never a silent fall back to Home
  const unknown = loc.id !== "" && !routeDef(loc.id);
  const scoped = isProjectRoute(routeId);
  const urlProject = scoped ? (loc.project ?? landing?.project ?? pickProject(me, prefs.project)) : null;
  const project = me.projects.find((p) => p.id === urlProject) ?? null;
  const projectId = scoped ? (project?.id ?? null) : (pickProject(me, prefs.project) ?? null);
  const noProjectAccess = scoped && !!loc.project && !project;

  // redirect (replace, no dead back step) to the canonical form of the URL
  useLayoutEffect(() => {
    if (scoped && !loc.project && project) replaceHash(formatHash(routeId, loc.param, project.id) + hashQuery(window.location.hash));
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

  // the Access and People screens keep `acc.*` / `ppl.*` in the real query string: leaving them drops those keys, so another screen never inherits a tab
  useEffect(() => {
    clearGovernQS(routeId);
  }, [routeId]);

  useEffect(() => {
    document.title = unknown ? `${loc.id} · Gantry Blueprint` : `${denied?.title ?? def?.title ?? "Home"} · Gantry Blueprint`;
  }, [def, denied, unknown]);

  // a truncated label keeps its full text one hover away
  useEffect(() => {
    const root = document.getElementById("app");
    if (!root) return;
    let raf = 0;
    const mark = () => {
      raf = 0;
      root.querySelectorAll<HTMLElement>(".trunc").forEach((e) => {
        if (!e.title && !e.closest("[title]") && e.textContent) e.title = e.textContent;
      });
    };
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(mark); });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    mark();
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

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
    setNavOpen((o) => !o);
    // opening moves focus into the drawer, onto its first link
    if (!navOpen) setTimeout(() => document.querySelector<HTMLElement>("#side a")?.focus(), 30);
  };
  const View = unknown ? VIEWS.home : (VIEWS[routeId] ?? VIEWS.home);
  const noAccess = hasNoAccess(me);
  const ready = !scoped || (!!project && synced === project.id);
  return (
    <>
    <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>Skip to content</a>
    <div id="app" className={`app${navOpen ? " nav-open" : ""}`}>
      <AppErrorBoundary level="chrome">
        <Nav me={me} current={unknown ? "" : denied ? denied.id : routeId} project={scoped ? project : null} open={navOpen} onNavigate={() => setNavOpen(false)} />
      </AppErrorBoundary>
      {navOpen ? <div className="scrim nav" id="nav-scrim" onClick={() => setNavOpen(false)} /> : null}
      <div className="main">
      <AppErrorBoundary level="chrome">
        <TopBar me={me} project={scoped ? project : null} current={routeId} onOpenNav={toggleNav} onOpenPalette={openPalette} />
      </AppErrorBoundary>
      <StopBanner projectId={scoped ? projectId : null} />
      <ViewAsBanner />
      <ReadOnlyBanner />
      <main className="content" id="main" tabIndex={-1} ref={main}>
        <AppErrorBoundary level="route" resetKey={`${routeId}/${loc.param ?? ""}`}>
          {noAccess ? (
            <div className="view">
              <Empty id="no-access" title="No access yet" text="Ask a Factory Admin or Project Admin to give you a role. Until then only your own profile is available." />
            </div>
          ) : noProjectAccess ? (
            <div className="view">
              <Empty id="no-project-access" title="You do not have access to this project" text="It may not exist, or you hold no role on it. Projects you cannot see are hidden from you." action={<p><a href="#projects" className="linkish">Back to all projects</a></p>} />
            </div>
          ) : unknown ? (
            <div className="view" id="route-not-found">
              <ViewHead sheet="notfound" title="Sheet not found" sub={`There is no route called "${loc.id}".`} />
              <Panel>
                <Empty title="Nothing drawn here" text="Check the address or pick a sheet from the navigation." action={<Btn label="Go home" kind="primary" id="not-found-home" onClick={() => navigate("home")} />} />
              </Panel>
            </div>
          ) : denied ? (
            // a page outside the person's roles: say so where they asked for it (the URL stays, so it works once access is granted)
            <div className="view">
              <ViewHead sheet={denied.id} title={denied.title} />
              <Panel>
                <Empty id="route-denied" icon="lock" title="No access to this sheet" text={`Your role cannot open ${denied.title}.${denied.perm ? ` Ask a factory admin for the ${denied.perm} permission.` : " Ask a factory admin for access."}`} action={<Btn label="Back to Home" id="route-denied-home" onClick={() => navigate("home")} />} />
              </Panel>
            </div>
          ) : ready ? (
            <Suspense fallback={<RouteSkeleton />}>{View ? <View /> : null}</Suspense>
          ) : null}
        </AppErrorBoundary>
      </main>
      </div>
    </div>
    </>
  );
}
