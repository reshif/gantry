/** The prototype's compact time formats for the work order screens: "14 Nov 10:24", "1d ago", "65 min". Wall-clock in UTC, like the prototype. */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const p2 = (n: number) => String(n).padStart(2, "0");

export function fmtDate(t: number | null | undefined): string {
  if (!t) return "—";
  const d = new Date(t);
  return `${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export function ago(t: number | null | undefined, now: number = Date.now()): string {
  if (!t) return "—";
  const s = Math.abs(now - t) / 1000;
  const u: [number, string] = s < 3600 ? [Math.max(1, Math.round(s / 60)), "m"] : s < 86400 ? [Math.round(s / 3600), "h"] : [Math.round(s / 86400), "d"];
  return now - t < 0 ? `in ${u[0]}${u[1]}` : `${u[0]}${u[1]} ago`;
}

export const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60000))} min`;

/** An actor's name as the prototype writes it (no "(agent)" suffix). */
export const plainName = (n: string): string => n.replace(/ \(agent\)$/, "");
