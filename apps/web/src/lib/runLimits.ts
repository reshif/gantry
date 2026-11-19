/**
 * Run limits as people type them: max turns, max time in minutes, max cost per run in dollars (optional). The server validates the same ranges and decides;
 * this only turns text into numbers, says what is wrong before a request is sent, and names the defaults shown when a field is unset.
 */
import type { RunLimits } from "@gantry/domain";

export const LIMIT_DEFAULTS = { turns: 40, minutes: 60 } as const;
export const LIMIT_RANGE = { turns: [1, 500], minutes: [1, 240], costUsd: [0.01, 100000] } as const;

export interface LimitText { turns: string; minutes: string; costUsd: string }
export type LimitErrors = Partial<Record<keyof LimitText, string>>;

const trim = (n: number): string => String(Math.round(n * 100) / 100);
export const minutesOf = (seconds: number): string => trim(seconds / 60);
export const textOf = (l: RunLimits | undefined | null): LimitText => ({
  turns: l?.turns ? String(l.turns) : "",
  minutes: l?.wallClockSeconds ? minutesOf(l.wallClockSeconds) : "",
  costUsd: l?.costUsd ? trim(l.costUsd) : "",
});

/** The fields as the API takes them (a blank field is left out), and what is wrong with what was typed. */
export function parseLimits(t: LimitText): { value: RunLimits; errors: LimitErrors } {
  const value: RunLimits = {};
  const errors: LimitErrors = {};
  const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));
  const turns = num(t.turns);
  if (turns !== null) {
    if (!Number.isInteger(turns) || turns < LIMIT_RANGE.turns[0] || turns > LIMIT_RANGE.turns[1]) errors.turns = `Whole number from ${LIMIT_RANGE.turns[0]} to ${LIMIT_RANGE.turns[1]}.`;
    else value.turns = turns;
  }
  const min = num(t.minutes);
  if (min !== null) {
    if (!Number.isFinite(min) || min < LIMIT_RANGE.minutes[0] || min > LIMIT_RANGE.minutes[1]) errors.minutes = `From ${LIMIT_RANGE.minutes[0]} to ${LIMIT_RANGE.minutes[1]} minutes.`;
    else value.wallClockSeconds = Math.round(min * 60);
  }
  const cost = num(t.costUsd);
  if (cost !== null) {
    if (!Number.isFinite(cost) || cost < LIMIT_RANGE.costUsd[0] || cost > LIMIT_RANGE.costUsd[1]) errors.costUsd = `From $${LIMIT_RANGE.costUsd[0]} to $${LIMIT_RANGE.costUsd[1]}.`;
    else value.costUsd = Math.round(cost * 100) / 100;
  }
  return { value, errors };
}

/** "40 turns · 60 min · $4" for a set of limits; fields left out are not listed. */
export function limitsLine(l: RunLimits | undefined | null): string {
  const parts = [l?.turns ? `${l.turns} turns` : "", l?.wallClockSeconds ? `${minutesOf(l.wallClockSeconds)} min` : "", l?.costUsd ? `$${trim(l.costUsd)}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "defaults";
}

/** What a run is bound by when the agent sets nothing: shown as the placeholder of an empty field. */
export function inheritedText(agent: { liveLimits?: RunLimits; liveBudget?: number } | undefined | null): LimitText {
  // The version on the floor is what a run is bound by, not the working copy an edit or a candidate may have changed.
  const l = agent?.liveLimits;
  return {
    turns: String(l?.turns ?? LIMIT_DEFAULTS.turns),
    minutes: l?.wallClockSeconds ? minutesOf(l.wallClockSeconds) : String(LIMIT_DEFAULTS.minutes),
    costUsd: l?.costUsd ? trim(l.costUsd) : agent?.liveBudget ? trim(agent.liveBudget) : "no cap",
  };
}
