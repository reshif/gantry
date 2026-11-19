/** A monthly cap is an amount above 0. Empty, 0, null and a missing budget all mean "no cap" (never "$NaN" or "$0"). */
export function monthlyCap(b: { monthly?: number | null } | null | undefined): number | null {
  const m = b?.monthly;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : null;
}
