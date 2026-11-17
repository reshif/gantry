/**
 * Which committed events become notifications (spec 12.2). `notifyEventFor` is the one place that maps the ledger's event types to the
 * catalogue of notification events (`NOTIFY_EVENTS`) that routes subscribe to. Kill and restore are mandatory: they cannot be switched off.
 */
import { NOTIFY_EVENTS } from "@gantry/domain";

export interface EventLike {
  type: string;
  category: string;
  outcome?: string;
  projectId?: string | null;
  woId?: string | null;
  subject?: { type: string; id: string } | null;
  after?: unknown;
  before?: unknown;
}

export interface NotifyMapping {
  /** The notification event id a route subscribes to (`NOTIFY_EVENTS`). */
  event: string;
  /** Kill and restore (and the halt and resume that ride with them): delivered even when the route or connection is switched off. */
  mandatory: boolean;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Notification events that can never be switched off, whatever a route or a connection says. */
export const MANDATORY_EVENTS: ReadonlySet<string> = new Set(["kill", "restore"]);
export const isMandatoryEvent = (event: string): boolean => MANDATORY_EVENTS.has(event);

export const NOTIFY_EVENT_IDS: ReadonlySet<string> = new Set(NOTIFY_EVENTS.map((e) => e.id));

/** The notification a committed event produces, or null when it is not one. Denied and failed attempts never notify (they are audit rows). */
export function notifyEventFor(e: EventLike): NotifyMapping | null {
  const a = obj(e.after);
  const ok = !e.outcome || e.outcome === "ok";
  const mk = (event: string): NotifyMapping => ({ event, mandatory: isMandatoryEvent(event) });
  switch (e.type) {
    case "wo.submit":
      return ok ? mk("submitted") : null;
    case "wo.question":
      return ok ? mk("question") : null;
    case "gate.waiting":
      return ok ? mk("gate.waiting") : null;
    case "gate.escalated":
      return ok ? mk("gate.escalated") : null;
    case "gate.decision":
      return ok ? mk("gate.decided") : null;
    case "wo.state":
      return ok && (a.to === "failed" || a.to === "blocked") ? mk("blocked") : null;
    case "wo.bay":
      return ok && a.bay === "sechold" ? mk("security.hold") : null;
    case "halt":
      return ok ? mk("andon") : null;
    case "kill":
      return ok ? mk("kill") : null;
    case "restore":
      // The first of two approvals to restore a factory kill is a request, not a restore.
      return ok && a.pending !== true ? mk("restore") : null;
    case "release":
      return ok ? mk("released") : null;
    case "onboarding.pr":
    case "onboarding.pr.updated":
    case "onboarding.session.update":
    case "onboarding.merged":
      return mk("onboarding.pr");
    case "delivery.failed":
      return mk("delivery.failed");
    case "wo.mention":
      return ok ? mk("mention") : null;
    default:
      break;
  }
  if (/^eval\./.test(e.type) && (e.outcome === "regression" || /regression/.test(e.type))) return mk("eval.regression");
  if (/^budget\./.test(e.type) && /threshold|breach|alert|hold/.test(e.type)) return mk("budget");
  if (/^trust\./.test(e.type) && ok && /grant|demote|propos|change/.test(e.type)) return mk("trust.changed");
  if (/^learning\./.test(e.type) && ok && /propos|finding/.test(e.type)) return mk("learning.proposed");
  if (e.type === "outcome.recorded") return mk("outcome.recorded");
  return null;
}

/** Events that close or change a gate card: the card posted for the open instance is updated in place (spec 12.2). */
export const isGateChange = (e: EventLike): boolean => e.type === "gate.decision" || e.type === "gate.reopened";
