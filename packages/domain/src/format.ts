/** Pure formatting helpers ported from G.fmt. All wall-clock display is IST (UTC+05:30). */
export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
export const IST_OFFSET_MS = 330 * MIN;

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Day of week (0 = Sunday) and minutes since midnight, in IST. */
export function ist(t: number): { day: number; mins: number } {
  const d = new Date(t + IST_OFFSET_MS);
  return { day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** "HH:MM" -> minutes since midnight ("24:00" = 1440). */
export function hm(s: string): number {
  const p = String(s).split(":");
  return Number(p[0]) * 60 + (Number(p[1]) || 0);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export const fmt = {
  money(n: number): string {
    return "$" + (n >= 1000 ? Math.round(n).toLocaleString("en-US") : Number(n).toFixed(2));
  },
  money0(n: number): string {
    return "$" + Math.round(n).toLocaleString("en-US");
  },
  num(n: number): string {
    return Math.round(n).toLocaleString("en-US");
  },
  k(n: number): string {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
  },
  pct(n: number, d?: number): string {
    return (n * 100).toFixed(d == null ? 0 : d) + "%";
  },
  dur(ms: number): string {
    if (ms < 0) ms = 0;
    const m = Math.floor(ms / MIN);
    if (m < 1) return "<1m";
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + pad2(m % 60) + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  },
  /** Relative time. `now` is explicit so the function stays pure. */
  ago(t: number, now: number): string {
    const d = now - t;
    return d < 45000 ? "just now" : fmt.dur(d) + " ago";
  },
  ist(t: number): string {
    const d = new Date(t + IST_OFFSET_MS);
    return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  },
  istDate(t: number): string {
    const d = new Date(t + IST_OFFSET_MS);
    return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  },
  stamp(t: number): string {
    return fmt.istDate(t) + " " + fmt.ist(t) + " IST";
  },
  iso(t: number): string {
    return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
  },
};

/** Epoch ms for an IST wall-clock date ("YYYY-MM-DD") and time ("HH:MM"). */
export function istTime(dateStr: string, timeStr?: string): number {
  return new Date(dateStr + "T" + (timeStr || "12:00") + ":00+05:30").getTime();
}

/** "YYYY-MM-DD" of the IST day `offsetDays` from `now`. */
export function istToday(now: number, offsetDays = 0): string {
  return new Date(now + IST_OFFSET_MS + offsetDays * DAY).toISOString().slice(0, 10);
}
