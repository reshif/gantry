/** One plural helper for every count string: `plural(1, "project")` -> "1 project", `plural(2, "project")` -> "2 projects". */
export const plural = (n: number, word: string, many?: string): string => `${n} ${n === 1 ? word : (many ?? `${word}s`)}`;

/** The verb that agrees with a count: "1 item needs attention", "2 items need attention". */
export const needs = (n: number): string => (n === 1 ? "needs" : "need");
