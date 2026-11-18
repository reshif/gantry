/** The prototype's `?state=` previews (loading, empty, error, forbidden, conflict) and its 404 page: same page header, same card, same copy. */
import { CrIcon, CrEmpty, Page } from "../ui/cr";
import { Btn } from "../ui/primitives";

export const PREVIEW_STATES = ["loading", "empty", "error", "forbidden", "conflict"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];
export const isPreviewState = (s: string | null | undefined): s is PreviewState => !!s && (PREVIEW_STATES as readonly string[]).includes(s);

const Skel = ({ w, h }: { w: string; h?: number }) => <div className="skel" style={{ width: w, ...(h ? { height: h } : {}) }} />;

function Body({ state }: { state: PreviewState }) {
  switch (state) {
    case "loading":
      return (
        <div className="stack" aria-busy="true" aria-label="Loading">
          <span className="sr">Loading…</span>
          <div className="stats" style={{ "--n": 4 } as React.CSSProperties}>
            {[1, 2, 3, 4].map((i) => (
              <div className="stat" key={i}>
                <Skel w="40%" />
                <Skel w="60%" h={28} />
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-b stack">{[90, 70, 80, 60, 85].map((w) => <Skel key={w} w={`${w}%`} />)}</div>
          </div>
        </div>
      );
    case "empty":
      return <div className="card"><CrEmpty title="Nothing here yet" text="When there is something to show it will appear here. You can start by creating the first item." action={<a className="btn primary" href="#console/submit">Submit a work order</a>} /></div>;
    case "error":
      return (
        <div className="card">
          <CrEmpty title="This view failed to load" text="The request did not complete. Nothing was changed." icon="warn" action={<div className="row"><Btn label="Retry" kind="primary" onClick={() => window.location.reload()} /><Btn label="Reload" onClick={() => window.location.reload()} /></div>} />
        </div>
      );
    case "forbidden":
      return <div className="card"><CrEmpty title="You do not have access to this" text="Your roles do not include this area. Ask a Factory Admin for the permission it needs, or return to a screen you can use." icon="lock" action={<a className="btn" href="#home">Back to Home</a>} /></div>;
    case "conflict":
      return (
        <>
          <div className="banner warn" role="alert">
            <CrIcon name="warn" />
            <div className="grow"><b>Conflict.</b> Someone else changed this while you were editing, so your edit was not saved. Your draft is kept below.</div>
            <Btn label="Reload latest" small onClick={() => window.location.reload()} />
          </div>
          <div className="card"><CrEmpty title="Nothing here yet" text="When there is something to show it will appear here. You can start by creating the first item." action={<a className="btn primary" href="#console/submit">Submit a work order</a>} /></div>
        </>
      );
  }
}

/** A route's page header over one of the preview states. */
export function StatePreview({ state, eyebrow, title, sub }: { state: PreviewState; eyebrow: string; title: string; sub?: string }) {
  return <Page eyebrow={eyebrow} title={title} {...(sub ? { sub } : {})}><Body state={state} /></Page>;
}

/** The 404 page (prototype): eyebrow 404, a card with a search icon, the missing page's name and a way home. */
export function NotFoundPage({ name }: { name: string }) {
  return (
    <Page eyebrow="404" title="Page not found" id="route-not-found">
      <div className="card">
        <CrEmpty title={`There is no “${name}” page`} text="The link may be old, or the page was renamed." icon="search" action={<a href="#home" className="btn primary" id="route-not-found-home">Go Home</a>} />
      </div>
    </Page>
  );
}
