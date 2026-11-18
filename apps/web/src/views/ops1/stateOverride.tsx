/**
 * The prototype's `?state=` switch (loading, empty, error, forbidden, conflict) for Home, Inbox and Agents at work. Every Control Room screen can be
 * opened in one of its shared states from the address bar (`/?state=error#home`), which is how a designer or a tester checks them. The page header stays and the
 * body is replaced by the shared state, in the prototype's markup.
 */
import { useState, type ReactNode } from "react";
import { ROLES } from "@gantry/domain";
import { useMe } from "../../api/queries";
import { hashFor } from "../../lib/router";
import { setRouteState, useClearRouteStateOnLeave, useRouteState } from "../../lib/queryState";
import { Btn } from "../../ui/primitives";
import { CrEmpty, CrIcon } from "../../ui/cr";

export type ShellState = "loading" | "empty" | "error" | "forbidden" | "conflict";
const STATES: ShellState[] = ["loading", "empty", "error", "forbidden", "conflict"];

/** The state asked for in the address bar, or null for the normal screen. */
export function useStateOverride(): ShellState | null {
  const [raw] = useRouteState("state", "");
  useClearRouteStateOnLeave(["state"]);
  return (STATES as string[]).includes(raw) ? (raw as ShellState) : null;
}

const reload = () => setRouteState({ state: null });

function Empty() {
  return (
    <div className="card">
      <CrEmpty title="Nothing here yet" text="When there is something to show it will appear here. You can start by creating the first item." action={<a className="btn primary" href={hashFor("console")}>Submit a work order</a>} />
    </div>
  );
}

/** A short id for a failed request, shown so a person can quote it ("Error id: e-4k2x9a"). */
const errorId = (): string => `e-${Math.random().toString(36).slice(2, 8)}`;

export function StateBody({ state }: { state: ShellState }): ReactNode {
  const me = useMe();
  const [eid] = useState(errorId);
  const roleId = me?.person.roles[0]?.role;
  const roleName = roleId ? (ROLES.find((r) => r.id === roleId)?.name ?? "") : "";
  if (state === "loading") {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading" id="state-loading">
        <span className="sr">Loading…</span>
        <div className="stats" style={{ "--n": 4 } as React.CSSProperties}>
          {[1, 2, 3, 4].map((i) => <div key={i} className="stat"><div className="skel" style={{ width: "40%" }} /><div className="skel" style={{ height: 28, width: "60%" }} /></div>)}
        </div>
        <div className="card"><div className="card-b stack">{[90, 70, 80, 60, 85].map((w) => <div key={w} className="skel" style={{ width: `${w}%` }} />)}</div></div>
      </div>
    );
  }
  if (state === "empty") return <div id="state-empty"><Empty /></div>;
  if (state === "error") {
    return (
      <div className="card" id="state-error">
        <CrEmpty icon="warn" title="This view failed to load" text={`The request did not complete. Nothing was changed. Error id: ${eid}`}
          action={<div className="row"><Btn label="Retry" kind="primary" id="state-retry" onClick={reload} /><Btn label="Reload" id="state-reload" onClick={() => window.location.reload()} /></div>} />
      </div>
    );
  }
  if (state === "forbidden") {
    return (
      <div className="card" id="state-forbidden">
        <CrEmpty icon="lock" title="You do not have access to this" text={`Your role${roleName ? ` (${roleName})` : ""} cannot open this area. Ask a Factory Admin for the \u201cpeople.manage\u201d permission, or return to a screen you can use.`}
          action={<a className="btn" href={hashFor("home")}>Back to Home</a>} />
      </div>
    );
  }
  return (
    <div id="state-conflict">
      <div className="banner warn" role="alert">
        <CrIcon name="warn" />
        <div className="grow"><b>Conflict.</b> Priya Nair changed this 2 minutes ago, so your edit was not saved. Your draft is kept below.</div>
        <Btn label="Reload latest" small id="state-reload-latest" onClick={reload} />
        <Btn label="Compare and merge" small kind="primary" id="state-merge" onClick={reload} />
      </div>
      <Empty />
    </div>
  );
}
