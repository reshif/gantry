/**
 * Schedule triggers (spec 11.7): the "When" field is text like `Mon 06:00 IST`, `Weekdays 09:30 UTC` or `Daily 06:00 Asia/Kolkata`.
 * Parsing is strict so a typo is refused at save time rather than silently never firing, and `nextRun` is exact for the zone (including daylight saving).
 */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ZONES: Record<string, string> = { ist: "Asia/Kolkata", utc: "UTC", gmt: "UTC", z: "UTC" };

export interface Schedule {
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  hour: number;
  minute: number;
  zone: string;
}

const validZone = (z: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

/** Returns the schedule, or a sentence saying what is wrong. */
export function parseSchedule(text: string, defaultZone = "UTC"): { ok: true; value: Schedule } | { ok: false; msg: string } {
  const bad = (why: string) => ({ ok: false as const, msg: `${why} Use a form like "Mon 06:00 IST", "Weekdays 09:30 UTC" or "Daily 06:00".` });
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return bad("Say when the schedule runs.");
  let zone = defaultZone;
  const last = parts[parts.length - 1]!;
  let timeIdx = parts.length - 1;
  if (!/^\d{1,2}:\d{2}$/.test(last)) {
    zone = ZONES[last.toLowerCase()] ?? last;
    if (!validZone(zone)) return bad(`"${last}" is not a time zone.`);
    timeIdx = parts.length - 2;
  }
  const t = /^(\d{1,2}):(\d{2})$/.exec(parts[timeIdx] ?? "");
  if (!t) return bad("The time must be HH:MM.");
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  if (hour > 23 || minute > 59) return bad("The time must be between 00:00 and 23:59.");
  const dayWords = parts.slice(0, timeIdx).join(" ").toLowerCase().replace(/^every\s+/, "");
  let days: number[];
  if (!dayWords || dayWords === "daily" || dayWords === "day") days = [0, 1, 2, 3, 4, 5, 6];
  else if (dayWords === "weekdays") days = [1, 2, 3, 4, 5];
  else if (dayWords === "weekends") days = [0, 6];
  else {
    days = [];
    for (const w of dayWords.split(/[,\s]+/).filter(Boolean)) {
      const i = DAYS.indexOf(w.slice(0, 3));
      if (i < 0 || w.length < 3) return bad(`"${w}" is not a day.`);
      if (!days.includes(i)) days.push(i);
    }
    if (!days.length) return bad("Name at least one day.");
  }
  return { ok: true, value: { days: days.sort(), hour, minute, zone } };
}

const parts = (ms: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour), mi: Number(o.minute), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday!) };
};

/** The UTC instant at which the wall clock in `zone` reads y-mo-d h:mi. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess, zone);
    guess += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return guess;
}

/** The first run strictly after `after`. */
export function nextRun(s: Schedule, after: Date): Date {
  const base = parts(after.getTime(), s.zone);
  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + add));
    if (!s.days.includes(day.getUTCDay())) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), s.hour, s.minute, s.zone);
    if (at > after.getTime()) return new Date(at);
  }
  throw new Error("no next run within eight days");
}
