/**
 * Factory status cluster facts (legacy G.statusInfo, minus the simulation): IST clock and shift,
 * release windows from policies, active and upcoming freezes. Pure so it can be tested.
 */
import { DAYS, fmt, hm, ist, type Freeze, type Policy } from "@gantry/domain";

export interface WindowInfo {
  id: string;
  name: string;
  open: boolean;
  projects: string[];
  text: string;
}
export interface FreezeInfo extends Freeze {
  active: boolean;
  upcoming: boolean;
}
export interface StatusInfo {
  at: number;
  clock: string;
  date: string;
  shift: "Weekend" | "Day shift" | "Out of hours";
  windows: WindowInfo[];
  freezes: FreezeInfo[];
  activeFreezes: FreezeInfo[];
  factory: "replay" | "killed" | "running";
}

export function statusInfo(
  t: number,
  o: { visibleProjectIds: readonly string[]; policies: readonly Policy[]; freezes: readonly Freeze[]; killed: boolean; replay: boolean },
): StatusInfo {
  const { day, mins } = ist(t);
  const weekend = day === 0 || day === 6;
  const shift = weekend ? "Weekend" : mins >= 540 && mins < 1140 ? "Day shift" : "Out of hours";
  const windows: WindowInfo[] = o.policies
    .filter((p) => p.enabled && p.effect === "allow" && p.when && p.actions.includes("release") && (!(p.where.projects ?? []).length || (p.where.projects ?? []).some((x) => o.visibleProjectIds.includes(x))))
    .map((p) => {
      const w = p.when;
      if (!w) throw new Error("unreachable: filtered on when");
      return {
        id: p.id,
        name: p.name,
        open: w.days.includes(day) && mins >= hm(w.from) && mins < hm(w.to),
        projects: p.where.projects ?? [],
        text: `${w.days.length === 7 ? "Every day" : w.days.map((x) => DAYS[x]).join(", ")} ${w.from}–${w.to} IST`,
      };
    });
  const freezes: FreezeInfo[] = o.freezes
    .map((f) => ({ ...f, active: f.from <= t && f.to > t, upcoming: f.from > t }))
    .filter((f) => f.active || f.upcoming);
  return {
    at: t,
    clock: fmt.ist(t),
    date: fmt.istDate(t),
    shift,
    windows,
    freezes,
    activeFreezes: freezes.filter((f) => f.active),
    factory: o.replay ? "replay" : o.killed ? "killed" : "running",
  };
}
