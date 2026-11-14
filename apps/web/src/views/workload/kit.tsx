/** Shared pieces of the Workload screen (legacy js/views/workload.js): formatting, rate cells that say "insufficient data" for small samples, and the deep links. */
import type { ReactNode } from "react";
import { fmt, MIN } from "@gantry/domain";
import { useCanMany } from "../../api/can";
import { useMe, useProjects } from "../../api/queries";
import { setProject } from "../../lib/prefs";
import { navigate } from "../../lib/router";
import { dec } from "../mcp/kit";
import type { Decision } from "../../ui/primitives";

export const MIN_N = 5;
export const MINUTES_NOTE = "an approval counts 6 minutes, a brief confirmation 4 and a conversation answer 3";

export const mins = (m: number | null | undefined): string => (m == null ? "–" : m < 60 ? `${Math.round(m)}m` : fmt.dur(m * MIN));
export const teamName = (m: { teams: Array<{ team: string; name: string }> }, id: string | null | undefined): string => (id ? m.teams.find((t) => t.team === id)?.name ?? id : "No team");
export const windowText = (days: number): string => (days === 1 ? "24 hours" : `${days} days`);

export function Rate({ num, den }: { num: number; den: number }) {
  if (!den) return <span className="muted small">no data</span>;
  if (den < MIN_N) return <span className="wl-insuf" title={`Only ${den} observations; at least ${MIN_N} are needed for a rate.`}><span className="mono">{`${num}/${den}`}</span><span className="wl-insuf-l">insufficient data</span></span>;
  return <span className="wl-rate"><span className="mono">{fmt.pct(num / den)}</span><span className="wl-n mono">{`n=${den}`}</span></span>;
}
export function MedianCell({ m, n }: { m: number | null | undefined; n: number }) {
  if (!n) return <span className="muted small">no data</span>;
  if (n < MIN_N) return <span className="wl-insuf" title={`Only ${n} timed approvals.`}><span className="mono">{mins(m)}</span><span className="wl-insuf-l">{`insufficient data, n=${n}`}</span></span>;
  return <span className="wl-rate"><span className="mono">{mins(m)}</span><span className="wl-n mono">{`n=${n}`}</span></span>;
}
export const Bar = ({ v, max, cls = "" }: { v: number; max: number; cls?: string }): ReactNode => (
  <span className={`wl-bar ${cls}`} aria-hidden="true"><span style={{ width: `${Math.max(2, Math.round((100 * v) / (max || 1)))}%` }} /></span>
);

/* ---------- deep links ---------- */
export const goConfig = (project: string): void => { setProject(project); navigate("project-config"); };
export const goTrust = (project?: string | null): void => { if (project) setProject(project); navigate("trust"); };
export const goPerson = (pid: string): void => navigate("people", pid);

/** Who may set a delegate: the person themselves, a people manager, or an approver-rule editor of some project they see (legacy delegateGuard). */
export function useDelegateGuard(pid: string): Decision {
  const me = useMe();
  const projects = useProjects().data ?? [];
  const checks = useCanMany([{ action: "people.manage" }, ...projects.map((p) => ({ action: "approvers.edit", project: p.id }))]);
  if (pid === me?.person.id) return { allowed: true, reason: "You can set your own delegate.", needs: "" };
  const m = checks[0]!;
  if (m.allowed) return dec(m);
  const any = checks.slice(1).find((c) => c.allowed);
  return any ? dec(any) : dec(m);
}
/** The project whose approver right lets this person set the delegate, when they have no people-manage right. */
export function useDelegateProject(pid: string): string | null {
  const me = useMe();
  const projects = useProjects().data ?? [];
  const checks = useCanMany([{ action: "people.manage" }, ...projects.map((p) => ({ action: "approvers.edit", project: p.id }))]);
  if (pid === me?.person.id || checks[0]!.allowed) return null;
  const i = checks.slice(1).findIndex((c) => c.allowed);
  return i >= 0 ? projects[i]!.id : null;
}
