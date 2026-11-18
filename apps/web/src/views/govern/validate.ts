import { useState } from "react";

/** Inline field validation for dialogs, as the prototype does it: a message under each invalid field, the first invalid field focused. */
export function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** `checks` maps a field id to its message (empty when valid), in page order. Returns true when nothing is invalid. */
  const run = (checks: Array<[id: string, message: string]>): boolean => {
    const next: Record<string, string> = {};
    for (const [id, m] of checks) if (m) next[id] = m;
    setErrors(next);
    const first = checks.find(([, m]) => m)?.[0];
    if (first) setTimeout(() => document.getElementById(first)?.focus(), 0);
    return !first;
  };
  const clear = (id: string) => setErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
  return { errors, run, clear };
}

export const required = (label: string, v: string): string => (v.trim() ? "" : `${label} is required.`);
export const minLen = (label: string, v: string, n: number): string => (v.trim().length < n ? `${label} needs at least ${n} characters.` : "");
