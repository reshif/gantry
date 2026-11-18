/**
 * Hash router. Factory routes: `#home`, `#projects`, `#agents`. Project routes carry the project in the
 * URL: `#/p/<projectId>/floor`, `#/p/<projectId>/record/WO-1042`. Legacy `#floor` / `#record/WO-1042`
 * still parse (project null) and the shell redirects them to the project form.
 * A route is `#<id>` optionally followed by `/<param>`. Unknown ids resolve to home.
 * (react-router is not used: its hash mode writes `#/path`, which would break legacy links.)
 */
import { useSyncExternalStore } from "react";
import { getPrefs } from "./prefs";
import { isProjectRoute } from "./routes";

export interface RouteLocation {
  /** The raw id from the hash, "" when empty. */
  id: string;
  /** The segment after the id, decoded; null when absent. */
  param: string | null;
  /** The project id from `#/p/<id>/...`, null for factory routes and legacy hashes. */
  project: string | null;
  /** The prototype's `?state=loading|empty|error|forbidden|conflict` preview, written after the route in the hash (`#home?state=empty`); null when absent. */
  state?: string | null;
}

const dec = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

export function parseHash(hash: string): RouteLocation {
  const full = hash.replace(/^#\/?/, "");
  const qi = full.indexOf("?");
  const raw = qi < 0 ? full : full.slice(0, qi);
  let state: string | null = null;
  if (qi >= 0) {
    try {
      state = new URLSearchParams(full.slice(qi + 1)).get("state");
    } catch {
      state = null;
    }
  }
  let [head = "", ...rest] = raw.split("/");
  let project: string | null = null;
  if (head === "p" && rest.length >= 2 && rest[0]) {
    project = dec(rest[0]);
    [head = "", ...rest] = rest.slice(1);
  }
  const tail = rest.join("/");
  return { id: head, param: tail ? dec(tail) : null, project, ...(state ? { state } : {}) };
}

export function formatHash(id: string, param?: string | null, project?: string | null): string {
  const pre = project ? `#/p/${encodeURIComponent(project)}/` : "#";
  return param ? `${pre}${id}/${encodeURIComponent(param)}` : `${pre}${id}`;
}

/** The hash for a route id: project routes get the current project (last chosen) unless one is given. */
export function hashFor(id: string, param?: string | null, project?: string | null): string {
  const pid = isProjectRoute(id) ? (project ?? getPrefs().project) : null;
  return formatHash(id, param, pid);
}

const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};
const snapshot = () => window.location.hash;

/** Current location parsed from the hash. */
export function useHash(): RouteLocation {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseHash(hash);
}

export function navigate(id: string, param?: string | null, project?: string | null): void {
  const next = hashFor(id, param, project);
  if (window.location.hash === next) return;
  window.location.hash = next;
}

/** Enter a project (default: its Floor). */
export function navigateProject(projectId: string, id = "floor", param?: string | null): void {
  navigate(id, param, projectId);
}

/** Replace the current history entry (redirects must not leave a dead back-button step). */
export function replaceHash(next: string): void {
  if (window.location.hash === next) return;
  window.location.replace(next);
}

export function openRecordRoute(woId: string): void {
  navigate("record", woId);
}
