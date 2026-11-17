/**
 * Client error reporter. No client-error endpoint exists on the API yet, so the default sink is a no-op: errors get an id
 * (shown to the person, quotable to support) and nothing leaves the browser. When the backend ships an authenticated,
 * size-capped endpoint, call `setErrorSink(post)` once at start-up; nothing else changes.
 *
 * Nothing identifying is ever sent: messages are scrubbed (emails, tokens, uuids, long numbers, URL query strings and
 * fragments), stacks keep only function names and file paths, the route is the route id (no record ids), and there is no
 * user agent, person id, storage content or request body. Duplicates inside a minute are dropped; at most 10 reports a minute.
 */

export interface ErrorReport {
  id: string;
  name: string;
  message: string;
  stack: string[];
  boundary: "root" | "chrome" | "route" | "global";
  /** Route id only, e.g. "record". Never the hash parameter. */
  route: string;
  ts: number;
}
export type ErrorSink = (r: ErrorReport) => void;

let sink: ErrorSink | null = null;
const recent = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;

const MAX_PER_MINUTE = 10;
const DEDUPE_MS = 60_000;

export function setErrorSink(fn: ErrorSink | null): void {
  sink = fn;
}

/** Test seam: forget dedupe and rate-limit state. */
export function resetReporter(): void {
  recent.clear();
  windowStart = 0;
  windowCount = 0;
}

export function scrub(text: string, max = 300): string {
  return text
    .replace(/https?:\/\/[^\s"')]+/gi, (u) => u.split(/[?#]/)[0] ?? "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b(?:bearer|token|key|secret|password)[=: ]+\S+/gi, "[secret]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]")
    .replace(/\d{5,}/g, "[n]")
    .slice(0, max);
}

function frames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(0, 12)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || l.includes("@"))
    .slice(0, 8)
    .map((l) => scrub(l.replace(/https?:\/\/[^/\s)]+/g, "").replace(/[?#][^\s)]*/g, ""), 160));
}

export function routeIdNow(): string {
  try {
    const h = window.location.hash.replace(/^#\/?/, "");
    const id = h.split(/[/?]/)[0] ?? "";
    return /^[a-z][a-z0-9-]{0,40}$/.test(id) ? id : "home";
  } catch {
    return "home";
  }
}

function newId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  }
}

export function buildReport(error: unknown, boundary: ErrorReport["boundary"], now: number = Date.now()): ErrorReport {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unknown error");
  return {
    id: newId(),
    name: scrub(e.name || "Error", 60),
    message: scrub(e.message || ""),
    stack: frames(e.stack),
    boundary,
    route: routeIdNow(),
    ts: now,
  };
}

/** Records an error. Always returns an id to show the person; sends to the sink unless deduplicated or rate-limited. */
export function reportError(error: unknown, boundary: ErrorReport["boundary"], now: number = Date.now()): string {
  const report = buildReport(error, boundary, now);
  if (!sink) return report.id;
  const fp = `${report.boundary}|${report.name}|${report.message}`;
  const seen = recent.get(fp);
  if (seen !== undefined && now - seen < DEDUPE_MS) return report.id;
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_PER_MINUTE) return report.id;
  windowCount++;
  recent.set(fp, now);
  if (recent.size > 50) recent.delete(recent.keys().next().value as string);
  try {
    sink(report);
  } catch {
    /* a failing reporter must never break the app */
  }
  return report.id;
}

/** window error and unhandledrejection -> reporter. Returns the uninstall function. */
export function installGlobalErrorReporter(): () => void {
  const onError = (e: ErrorEvent): void => void reportError(e.error ?? e.message, "global");
  const onRejection = (e: PromiseRejectionEvent): void => void reportError(e.reason, "global");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
