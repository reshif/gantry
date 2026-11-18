/**
 * The shared page states of the Control Room prototype (`?state=loading|empty|error|forbidden|conflict`) and the 404 page.
 * `?state=` is a preview: the design-system page links to it so every screen's loading, empty, failed, refused and conflict
 * look can be seen on demand. It never replaces real data states (those come from `<Async>`); it draws the same cards.
 * Copy that names a person, role or permission is not invented here: the preview says it generically.
 */
import { useMemo } from "react";
import { CrEmpty, CrIcon, Page } from "../ui/cr";
import { hashQuery } from "../lib/router";
import { useAccessMatrix, useMe } from "../api/queries";

export const SHARED_STATES = ["loading", "empty", "error", "forbidden", "conflict"] as const;
export type SharedStateKind = (typeof SHARED_STATES)[number];

/** The `state` carried by the URL, when it names one of the shared states. */
export function sharedStateFromUrl(hash: string = window.location.hash, search: string = window.location.search): SharedStateKind | null {
  const v = hashQuery(hash, search).get("state");
  return (SHARED_STATES as readonly string[]).includes(v ?? "") ? (v as SharedStateKind) : null;
}

/** Leaves the preview: the same route without `?state=`. */
export function clearSharedState(): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("state");
  const hash = u.hash.replace(/\?.*$/, "");
  window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

const sk = (w: number, h?: number) => <div className="skel" style={{ width: `${w}%`, ...(h ? { height: h } : {}) }} />;

function Loading() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading" role="status">
      <span className="sr">Loading…</span>
      <div className="stats" style={{ "--n": 4 } as React.CSSProperties}>
        {[1, 2, 3, 4].map((i) => <div className="stat" key={i}>{sk(40)}{sk(60, 28)}</div>)}
      </div>
      <div className="card"><div className="card-b stack">{[90, 70, 80, 60, 85].map((w) => <div key={w} className="skel" style={{ width: `${w}%` }} />)}</div></div>
    </div>
  );
}

function ErrorCard({ message }: { message?: string }) {
  const id = useMemo(() => `e-${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div className="card">
      <CrEmpty
        icon="warn"
        title="This view failed to load"
        text={`${message ?? "The request did not complete."} Nothing was changed. Error id: ${id}`}
        action={<div className="row"><button type="button" className="btn primary" onClick={clearSharedState}>Retry</button><button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button></div>}
      />
    </div>
  );
}

function EmptyCard() {
  return (
    <div className="card">
      <CrEmpty title="Nothing here yet" text="When there is something to show it will appear here. You can start by creating the first item." action={<a className="btn primary" href="#console">Submit a work order</a>} />
    </div>
  );
}

/** The refused card names the viewer's role from the session; the missing permission is only known to a real refusal, so the preview says it is not available. */
function ForbiddenCard() {
  const me = useMe();
  const roles = useAccessMatrix().data?.roles ?? [];
  const ids = (me?.person.roles ?? []).map((g) => g.role);
  const names = [...new Set(ids)].map((id) => roles.find((r) => r.id === id)?.name ?? id);
  const who = names.length ? names.join(", ") : "not available";
  return (
    <div className="card">
      <CrEmpty
        icon="lock"
        title="You do not have access to this"
        text={`Your role (${who}) cannot open this area. Ask a Factory Admin for the permission it needs (permission name: not available in this preview), or return to a screen you can use.`}
        action={<a className="btn" href="#home">Back to Home</a>}
      />
    </div>
  );
}

export function SharedState({ kind }: { kind: SharedStateKind }) {
  switch (kind) {
    case "loading":
      return <Loading />;
    case "empty":
      return <EmptyCard />;
    case "error":
      return <ErrorCard />;
    case "forbidden":
      return <ForbiddenCard />;
    case "conflict":
      return (
        <>
          <div className="banner warn" role="alert">
            <CrIcon name="warn" />
            <div className="grow"><b>Conflict.</b> Someone changed this while you were editing, so your edit was not saved. Your draft is kept below.</div>
            <button type="button" className="btn sm" onClick={clearSharedState}>Reload latest</button>
            <button type="button" className="btn sm primary">Compare and merge</button>
          </div>
          <EmptyCard />
        </>
      );
  }
}

/** The prototype's eyebrow for a route: its nav group there (Operate, Portfolio, Workforce, Govern, Connect, Reference). */
const PORTFOLIO = new Set(["projects", "onboarding", "project-config"]);
export function protoEyebrow(routeId: string, group: string): string {
  if (PORTFOLIO.has(routeId)) return "Portfolio";
  if (group === "Overview" || group === "Project") return "Operate";
  if (group === "Agents") return "Workforce";
  return group;
}

/** A route's page frame with one shared state inside it (prototype `G.pageShell`). */
export function SharedStatePage({ kind, eyebrow, title, sub }: { kind: SharedStateKind; eyebrow: string; title: string; sub?: string }) {
  return <Page eyebrow={eyebrow} title={title} sub={sub}><SharedState kind={kind} /></Page>;
}

export function NotFoundPage({ name }: { name: string }) {
  return (
    <Page eyebrow="404" title="Page not found">
      <div className="card"><CrEmpty icon="search" title={`There is no “${name}” page`} text="The link may be old, or the page was renamed." action={<a className="btn primary" href="#home">Go Home</a>} /></div>
    </Page>
  );
}
