/** Expected failures are values. Throw only for bugs. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** The rule that produced a decision (kept legacy-shaped: `kind` + `id` + optional `name`). */
export interface RuleRef {
  kind: string;
  id: string;
  name?: string;
  freeze?: string;
}

/**
 * Tagged error for refused commands. Maps onto the API contract:
 * denied -> 403, conflict/stale/stopped -> 409, invalid -> 422, not_found -> 404.
 */
export type GantryError =
  | { kind: "denied"; msg: string; rule?: RuleRef; needs?: string }
  | { kind: "conflict"; msg: string; rule?: RuleRef; needs?: string }
  | { kind: "stale"; msg: string; rule?: RuleRef; needs?: string }
  | { kind: "stopped"; msg: string; rule?: RuleRef; needs?: string }
  | { kind: "invalid"; msg: string; rule?: RuleRef; needs?: string }
  | { kind: "not_found"; msg: string; rule?: RuleRef; needs?: string };

export type GantryErrorKind = GantryError["kind"];

export function gantryError(kind: GantryErrorKind, msg: string, extra?: { rule?: RuleRef; needs?: string }): GantryError {
  const e: GantryError = { kind, msg };
  if (extra?.rule !== undefined) e.rule = extra.rule;
  if (extra?.needs !== undefined && extra.needs !== "") e.needs = extra.needs;
  return e;
}

/** HTTP status the API adapter should use for an error kind. */
export function httpStatusFor(kind: GantryErrorKind): 403 | 404 | 409 | 422 {
  switch (kind) {
    case "denied":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "stale":
    case "stopped":
      return 409;
    case "invalid":
      return 422;
  }
}

/** The `{ ok:false, msg, rule?, needs? }` body of a refused command. */
export function refusalBody(e: GantryError): { ok: false; msg: string; rule?: RuleRef; needs?: string } {
  const body: { ok: false; msg: string; rule?: RuleRef; needs?: string } = { ok: false, msg: e.msg };
  if (e.rule) body.rule = e.rule;
  if (e.needs) body.needs = e.needs;
  return body;
}
