/** The signed-in app shell (legacy app.js): top bar, kill banner, left nav, main view and global keys. */
import { Component, Suspense, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { Me } from "../api/types";
import { useCanSession } from "../api/can";
import { VIEWS } from "../views";
import { pickProject, resolveRoute, routeDef } from "../lib/routes";
import { useHash } from "../lib/router";
import { updatePrefs, usePrefs } from "../lib/prefs";
import { Empty } from "../ui/primitives";
import { useUI } from "../ui/overlay-context";
import { Nav, useRouteCtx } from "./Nav";
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
  const [navOpen, setNavOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  const { id: routeId, denied } = resolveRoute(loc.id, me, ctx);
  const def = routeDef(routeId);
  const projectId = pickProject(me, prefs.project);
  const project = me.projects.find((p) => p.id === projectId) ?? null;

  // keep the stored project one the person can see (legacy syncAuth)
  useEffect(() => {
    if (projectId && projectId !== prefs.project) updatePrefs({ project: projectId });
  }, [projectId, prefs.project]);

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
    document.title = `${def?.title ?? "Home"} · Gantry Software Factory`;
  }, [def]);

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

  const View = VIEWS[routeId] ?? VIEWS.home;
  const killed = !!me.factory.killed;
  return (
    <div id="app" className={`shell${prefs.navRail ? " nav-rail" : ""}${navOpen ? " nav-open" : ""}`}>
      <TopBar me={me} projectId={projectId} onOpenNav={() => setNavOpen(true)} onOpenPalette={openPalette} />
      <div className="sysbanner" id="sysbanner" hidden={!killed}>
        {killed ? <StopBanner projectId={null} /> : null}
      </div>
      <Nav me={me} current={routeId} projectName={project?.name ?? null} onNavigate={() => setNavOpen(false)} />
      <div className="nav-scrim" id="nav-scrim" hidden={!navOpen} onClick={() => setNavOpen(false)} />
      <main className="main" id="main" tabIndex={-1} ref={main}>
        {def?.project && !killed ? <StopBanner projectId={projectId} /> : null}
        <ViewBoundary key={`${routeId}/${loc.param ?? ""}`}>
          <Suspense fallback={null}>{View ? <View /> : null}</Suspense>
        </ViewBoundary>
      </main>
    </div>
  );
}
